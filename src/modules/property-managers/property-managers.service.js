/**
 * Property-managers service — Capa 2: conexiones reales por tenant.
 * CRUD pms_connections, testConnection. triggerSync encola job pms-sync;
 * el worker en mordecai-workers procesa el job y ejecuta runSync (4 pasos).
 * Credentials are encrypted at rest (AES-256-GCM) and never returned to the client.
 */
import { Op } from 'sequelize';
import {
  PmsConnection,
  PmsDebtor,
  PmsLease,
  PmsProperty,
  PmsUnit,
  PmsPortfolio,
  Software,
  ArCharge,
  ArPayment,
  ArBalance,
  ArAgingSnapshot,
  Debtor,
  DebtCase,
} from '../../models/index.js';
import { tenantRepository } from '../tenants/tenant.repository.js';
import { getConnector, hasConnector } from './connectors/connector.factory.js';
import { addPmsSyncJob, addBuildCasesJob, addBuildNewCasesJob, addRefreshCasesJob, addSyncFullFlowJob } from '../../queues/pms-sync.queue.js';
import { acquireLock } from '../../utils/pms-sync-lock.js';
import { buildNewCasesFromPms } from './case-build.service.js';
import { refreshCasesFromPms } from './case-refresh.service.js';
import { runSync } from './sync/sync-runner.service.js';
import { NotFoundError, BadRequestError, ConflictError } from '../../errors/index.js';
import { automationService } from '../automations/automation.service.js';
import { logger } from '../../utils/logger.js';
import {
  encryptCredentials,
  decryptCredentials,
  isEncryptedPayload,
} from '../../utils/credentials-crypto.js';
import { formatSingleLineMailingAddress } from '../../utils/mailing-address.js';

const VALID_STATUSES = ['draft', 'connected', 'syncing', 'error', 'disabled'];

async function ensureTenant(tenantId) {
  const tenant = await tenantRepository.findById(tenantId);
  if (!tenant) throw new NotFoundError('Tenant');
  return tenant;
}

async function getSoftwareByKey(softwareKey) {
  const software = await Software.findOne({
    where: { key: softwareKey, isEnabled: true },
  });
  if (!software) throw new NotFoundError('Software');
  return software;
}

export const propertyManagersService = {
  listByTenant: async (tenantId) => {
    await ensureTenant(tenantId);
    return await PmsConnection.findAll({
      where: { tenantId },
      include: [
        {
          association: 'software',
          attributes: ['id', 'key', 'name', 'authType', 'logoUrl'],
        },
        {
          association: 'syncRuns',
          where: { status: { [Op.in]: ['pending', 'running'] } },
          required: false,
          limit: 1,
          order: [['startedAt', 'DESC']],
          attributes: ['id', 'step', 'stats', 'status', 'startedAt'],
          separate: true,
        },
      ],
      order: [['createdAt', 'DESC']],
    });
  },

  getById: async (tenantId, connectionId) => {
    await ensureTenant(tenantId);
    const connection = await PmsConnection.findOne({
      where: { id: connectionId, tenantId },
      include: [
        {
          association: 'software',
          attributes: ['id', 'key', 'name', 'authType', 'logoUrl', 'docsUrl'],
        },
      ],
    });
    if (!connection) throw new NotFoundError('PmsConnection');
    return connection;
  },

  /**
   * Returns only the decrypted credentials for a connection. Used when the user
   * opens the edit form (authenticated request).
   */
  getCredentials: async (tenantId, connectionId) => {
    const withCreds = await propertyManagersService.getByIdWithDecryptedCredentials(
      tenantId,
      connectionId
    );
    return { credentials: withCreds.credentials ?? null };
  },

  /**
   * Same as getById but with credentials decrypted for internal use (connector).
   * Do not expose the returned object to the client.
   */
  getByIdWithDecryptedCredentials: async (tenantId, connectionId) => {
    const connection = await propertyManagersService.getById(tenantId, connectionId);
    const plain = connection.get({ plain: true });
    const credentials = isEncryptedPayload(plain.credentials)
      ? decryptCredentials(plain.credentials)
      : plain.credentials;
    return { ...plain, credentials };
  },

  create: async (tenantId, body) => {
    await ensureTenant(tenantId);
    const { softwareKey, credentials = null, status = 'draft' } = body;
    if (!softwareKey) throw new BadRequestError('softwareKey is required');

    const software = await getSoftwareByKey(softwareKey);
    const existing = await PmsConnection.findOne({
      where: { tenantId, softwareId: software.id },
    });

    const targetStatus = status || 'draft';
    if (existing) {
      const canReconnect = ['disabled', 'draft'].includes(existing.status);
      if (canReconnect) {
        const toStore =
          credentials != null
            ? encryptCredentials(credentials)
            : existing.credentials;
        await existing.update({
          credentials: toStore,
          status: targetStatus,
          lastError: null,
        });
        return await PmsConnection.findByPk(existing.id, {
          include: [
            {
              association: 'software',
              attributes: ['id', 'key', 'name', 'authType', 'logoUrl'],
            },
          ],
        });
      }
      throw new ConflictError('A connection for this software already exists for this tenant');
    }

    const connection = await PmsConnection.create({
      tenantId,
      softwareId: software.id,
      status: targetStatus,
      credentials:
        credentials != null ? encryptCredentials(credentials) : null,
      capabilities: software.capabilities ?? null,
    });
    return await PmsConnection.findByPk(connection.id, {
      include: [
        {
          association: 'software',
          attributes: ['id', 'key', 'name', 'authType', 'logoUrl'],
        },
      ],
    });
  },

  updateCredentials: async (tenantId, connectionId, credentials) => {
    const connection = await propertyManagersService.getById(tenantId, connectionId);
    const toStore =
      credentials != null
        ? encryptCredentials(credentials)
        : connection.credentials;
    await connection.update({
      credentials: toStore,
      lastError: null,
    });
    return connection.reload();
  },

  updateStatus: async (tenantId, connectionId, status) => {
    if (!VALID_STATUSES.includes(status)) {
      throw new BadRequestError(`status must be one of: ${VALID_STATUSES.join(', ')}`);
    }
    const connection = await propertyManagersService.getById(tenantId, connectionId);
    await connection.update({ status });
    return connection.reload();
  },

  /**
   * Update connection capabilities (merge with existing).
   * Used to set payment.allowed and payment.link when PMS supports payments (e.g. Rentvine).
   */
  updateCapabilities: async (tenantId, connectionId, capabilities) => {
    const connection = await propertyManagersService.getById(tenantId, connectionId);
    const current = connection.capabilities ?? {};
    const merged = { ...current, ...capabilities };
    if (capabilities.payment) {
      merged.payment = { ...(current.payment ?? {}), ...capabilities.payment };
    }
    await connection.update({ capabilities: merged });
    return connection.reload();
  },

  /**
   * Delete a PMS connection. Removes the record from the database.
   */
  delete: async (tenantId, connectionId) => {
    const connection = await propertyManagersService.getById(tenantId, connectionId);
    await connection.destroy();
    return { deleted: true, connectionId };
  },

  testConnection: async (tenantId, connectionId) => {
    const connectionWithCreds = await propertyManagersService.getByIdWithDecryptedCredentials(
      tenantId,
      connectionId
    );
    const software = await Software.findByPk(connectionWithCreds.softwareId);
    if (!software) throw new NotFoundError('Software');

    if (!hasConnector(software.key)) {
      throw new BadRequestError(`Connector not available for software: ${software.key}`);
    }
    const connector = getConnector(software.key, connectionWithCreds);
    return await connector.testConnection();
  },

  /**
   * Test credentials without persisting. Uses the connector to hit the PMS API
   * (e.g. Rentvine /portfolios/search). Returns { ok, message }.
   */
  testCredentials: async (tenantId, body) => {
    await ensureTenant(tenantId);
    const { softwareKey, credentials = {} } = body;
    if (!softwareKey) throw new BadRequestError('softwareKey is required');

    const software = await getSoftwareByKey(softwareKey);
    if (!hasConnector(software.key)) {
      throw new BadRequestError(`Connector not available for software: ${software.key}`);
    }

    const fakeConnection = { credentials };
    const connector = getConnector(software.key, fakeConnection);
    return await connector.testConnection();
  },

  /**
   * Enqueue a sync job and set connection to syncing. Worker (mordecai-workers) processes the job.
   * @param {{ steps?: string[] }} [opts] - If steps is set (e.g. ['debtors_leases']), only those steps run.
   */
  triggerSync: async (tenantId, connectionId, opts = {}) => {
    const connection = await propertyManagersService.getById(tenantId, connectionId);
    const software = await Software.findByPk(connection.softwareId);
    if (!software) throw new NotFoundError('Software');

    if (connection.status === 'syncing') {
      throw new ConflictError('A sync is already in progress for this connection');
    }
    if (!(await acquireLock(tenantId, connectionId))) {
      throw new ConflictError('A sync is already in progress for this connection');
    }
    if (!['connected', 'error'].includes(connection.status)) {
      throw new BadRequestError('Connection must be in connected or error state to sync');
    }
    if (!hasConnector(software.key)) {
      throw new BadRequestError(`Connector not available for software: ${software.key}`);
    }

    const jobId = await addPmsSyncJob(connectionId, tenantId, { trigger: 'manual', steps: opts.steps ?? null });
    if (jobId == null) {
      throw new BadRequestError(
        'Sync queue is not available. Set REDIS_URL to enable on-demand sync (worker must be running).'
      );
    }

    const prevSyncState = connection.syncState ?? {};
    await connection.update({
      status: 'syncing',
      lastError: null,
      syncState: { ...prevSyncState, lastRunStatus: 'IN_PROGRESS', lastErrorMessage: null },
    });
    return {
      enqueued: true,
      jobId,
      connectionId: connection.id,
      status: 'syncing',
      message: 'Sync requested. The worker will process the job.',
    };
  },

  /**
   * Enqueue build-cases job. Returns { enqueued: true, jobId } or throws if queue unavailable.
   * The worker runs the actual buildDebtCasesFromPms logic.
   */
  enqueueBuildCasesFromPms: async (tenantId, connectionId) => {
    await ensureTenant(tenantId);
    const connection = await propertyManagersService.getById(tenantId, connectionId);
    if (!(await acquireLock(tenantId, connectionId))) {
      throw new ConflictError('A sync or build is already in progress for this connection');
    }
    const jobId = await addBuildNewCasesJob(connectionId, tenantId);
    if (jobId == null) {
      throw new BadRequestError(
        'Build cases queue is not available. Set REDIS_URL and ensure the worker is running.'
      );
    }
    const prevSyncState = connection.syncState ?? {};
    await connection.update({
      syncState: { ...prevSyncState, lastRunStatus: 'IN_PROGRESS', lastErrorMessage: null },
    });
    return { enqueued: true, jobId };
  },

  enqueueRefreshCasesFromPms: async (tenantId, connectionId) => {
    await ensureTenant(tenantId);
    const connection = await propertyManagersService.getById(tenantId, connectionId);
    if (!(await acquireLock(tenantId, connectionId))) {
      throw new ConflictError('A sync or refresh is already in progress for this connection');
    }
    const jobId = await addRefreshCasesJob(connectionId, tenantId);
    if (jobId == null) {
      throw new BadRequestError(
        'Refresh cases queue is not available. Set REDIS_URL and ensure the worker is running.'
      );
    }
    const prevSyncState = connection.syncState ?? {};
    await connection.update({
      syncState: { ...prevSyncState, lastRunStatus: 'IN_PROGRESS', lastErrorMessage: null },
    });
    return { enqueued: true, jobId };
  },

  enqueueSyncFullFlow: async (tenantId, connectionId) => {
    await ensureTenant(tenantId);
    const connection = await propertyManagersService.getById(tenantId, connectionId);
    if (connection.status === 'syncing') {
      throw new ConflictError('A sync is already in progress for this connection');
    }
    if (!(await acquireLock(tenantId, connectionId))) {
      throw new ConflictError('A sync is already in progress for this connection');
    }
    if (!['connected', 'error'].includes(connection.status)) {
      throw new BadRequestError('Connection must be in connected or error state');
    }
    const jobId = await addSyncFullFlowJob(connectionId, tenantId);
    if (jobId == null) {
      throw new BadRequestError(
        'Sync full flow queue is not available. Set REDIS_URL and ensure the worker is running.'
      );
    }
    const prevSyncState = connection.syncState ?? {};
    await connection.update({
      status: 'syncing',
      lastError: null,
      syncState: { ...prevSyncState, lastRunStatus: 'IN_PROGRESS', lastErrorMessage: null },
    });
    return { enqueued: true, jobId };
  },

  getPmsJobStatus: async (tenantId, connectionId, jobId) => {
    await ensureTenant(tenantId);
    await propertyManagersService.getById(tenantId, connectionId);
    const { getJobById } = await import('../../queues/pms-sync.queue.js');
    const job = await getJobById(jobId);
    if (!job || job.data?.tenantId !== tenantId || job.data?.connectionId !== connectionId) {
      return null;
    }
    const state = await job.getState();
    return {
      status: state,
      result: job.returnvalue ?? null,
      failedReason: job.failedReason ?? null,
    };
  },

  /**
   * Build debt_cases (and debtors) from PMS data so automations can enroll them.
   * Uses ArBalance (balance > 0) + PmsLease + PmsDebtor. Creates/updates core Debtor and DebtCase per lease with balance.
   * Called by the worker when processing a build-cases job.
   */
  buildDebtCasesFromPms: async (tenantId, connectionId) => {
    await ensureTenant(tenantId);
    const connection = await propertyManagersService.getById(tenantId, connectionId);

    const balances = await ArBalance.findAll({
      where: {
        tenantId,
        pmsConnectionId: connectionId,
        balanceCents: { [Op.gt]: 0 },
      },
      order: [['asOfDate', 'DESC']],
      raw: true,
    });
    const latestByLease = new Map();
    for (const b of balances) {
      if (!latestByLease.has(b.pms_lease_id)) {
        latestByLease.set(b.pms_lease_id, b);
      }
    }
    const leaseIds = [...latestByLease.keys()];
    if (leaseIds.length === 0) {
      return {
        created: 0,
        updated: 0,
        total: 0,
        message: 'No leases with balance > 0. Run "Sync full flow" first to load debtors, leases, charges and balances from your PMS.',
      };
    }

    // Compute days past due per lease from oldest unpaid charge due date
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayTime = today.getTime();
    const chargesByLease = await ArCharge.findAll({
      where: { pmsLeaseId: { [Op.in]: leaseIds }, pmsConnectionId: connectionId },
      attributes: ['pmsLeaseId', 'dueDate', 'openAmountCents', 'amountCents'],
      raw: true,
    });
    const daysPastDueByLease = new Map();
    for (const c of chargesByLease) {
      const openCents = Number(c.open_amount_cents ?? c.openAmountCents ?? c.amount_cents ?? c.amountCents ?? 0);
      if (openCents <= 0) continue;
      const due = c.due_date ?? c.dueDate;
      if (!due) continue;
      const leaseId = c.pms_lease_id ?? c.pmsLeaseId;
      const dueTime = new Date(due).getTime();
      const dpd = Math.max(0, Math.floor((todayTime - dueTime) / (24 * 60 * 60 * 1000)));
      const existing = daysPastDueByLease.get(leaseId);
      if (existing == null || dpd > existing.daysPastDue) {
        daysPastDueByLease.set(leaseId, { daysPastDue: dpd, dueDate: due });
      }
    }
    logger.info(
      { connectionId, chargesCount: chargesByLease.length, leasesWithDpd: daysPastDueByLease.size },
      'Build cases: DPD from charges'
    );

    const leases = await PmsLease.findAll({
      where: { id: { [Op.in]: leaseIds } },
      include: [
        { model: PmsDebtor, as: 'pmsDebtor', required: true },
        { model: PmsProperty, as: 'pmsProperty', required: false },
        { model: PmsUnit, as: 'pmsUnit', required: false },
      ],
    });
    const debtorCache = new Map();
    const existingCases = await DebtCase.findAll({
      where: { tenantId },
      attributes: ['id', 'debtorId', 'pmsLeaseId', 'amountDueCents', 'meta'],
    });
    const casesByPmsLeaseId = new Map();
    for (const dc of existingCases) {
      const leaseId = dc.pmsLeaseId ?? dc.meta?.pms_lease_id;
      if (leaseId && (dc.meta?.source === 'pms' && dc.meta?.pms_connection_id === connectionId)) {
        casesByPmsLeaseId.set(String(leaseId), dc);
      }
    }

    let created = 0;
    let updated = 0;
    for (const lease of leases) {
      const pmsDebtor = lease.pmsDebtor;
      if (!pmsDebtor) continue;
      const bal = latestByLease.get(lease.id);
      if (!bal || Number(bal.balance_cents) <= 0) continue;

      let debtor = debtorCache.get(pmsDebtor.id);
      if (!debtor) {
        const externalRef = `pms:${connectionId}:${pmsDebtor.externalId}`;
        const [d] = await Debtor.findOrCreate({
          where: { tenantId, externalRef },
          defaults: {
            tenantId,
            externalRef,
            fullName: pmsDebtor.displayName || 'Unknown',
            email: pmsDebtor.email ?? null,
            phone: pmsDebtor.phone ?? null,
            metadata: { pms_debtor_id: pmsDebtor.id },
          },
        });
        if (d) {
          const addrLine = formatSingleLineMailingAddress(pmsDebtor.address);
          const prevMeta =
            d.metadata && typeof d.metadata === 'object' && !Array.isArray(d.metadata) ? d.metadata : {};
          await d.update({
            fullName: pmsDebtor.displayName || d.fullName,
            email: pmsDebtor.email ?? d.email,
            phone: pmsDebtor.phone ?? d.phone,
            metadata: {
              ...prevMeta,
              pms_debtor_id: pmsDebtor.id,
              ...(addrLine ? { mailing_address_single_line: addrLine } : {}),
            },
          }).catch(() => {});
        }
        debtor = d;
        debtorCache.set(pmsDebtor.id, debtor);
      } else {
        const addrLine = formatSingleLineMailingAddress(pmsDebtor.address);
        const prevMeta =
          debtor.metadata && typeof debtor.metadata === 'object' && !Array.isArray(debtor.metadata)
            ? debtor.metadata
            : {};
        if (addrLine && addrLine !== prevMeta.mailing_address_single_line) {
          const nextMeta = { ...prevMeta, pms_debtor_id: pmsDebtor.id, mailing_address_single_line: addrLine };
          await debtor.update({ metadata: nextMeta }).catch(() => {});
          debtor.metadata = nextMeta;
        }
      }

      const rawCents = bal.balance_cents ?? bal.balanceCents ?? 0;
      const amountDueCents = Math.round(Number(rawCents)) || 0;
      if (amountDueCents <= 0 || !Number.isFinite(amountDueCents)) continue;

      const aging = daysPastDueByLease.get(lease.id);
      const daysPastDue = aging ? aging.daysPastDue : 0;
      const dueDate = aging ? aging.dueDate : null;

      const propertyAddress = formatSingleLineMailingAddress(lease.pmsProperty?.address);
      const debtorAddress = formatSingleLineMailingAddress(pmsDebtor.address);

      const meta = {
        source: 'pms',
        pms_connection_id: connectionId,
        pms_lease_id: lease.id,
        pms_debtor_id: pmsDebtor.id,
        lease_number: lease.leaseNumber ?? lease.externalId ?? null,
        property_name: lease.pmsProperty?.name ?? null,
        property_address: propertyAddress || null,
        debtor_address: debtorAddress || null,
        unit_number: lease.pmsUnit?.unitNumber ?? null,
      };
      const leaseIdStr = String(lease.id);
      const existing = casesByPmsLeaseId.get(leaseIdStr);
      if (existing) {
        await DebtCase.update(
          {
            pmsLeaseId: lease.id,
            amountDueCents,
            currency: bal.currency || 'USD',
            daysPastDue,
            dueDate: dueDate || undefined,
            meta: { ...(existing.meta || {}), ...meta },
            nextActionAt: existing.nextActionAt || new Date(),
          },
          { where: { id: existing.id } }
        );
        updated++;
      } else {
        await DebtCase.create({
          tenantId,
          debtorId: debtor.id,
          pmsLeaseId: lease.id,
          amountDueCents,
          currency: bal.currency || 'USD',
          daysPastDue,
          dueDate: dueDate || undefined,
          status: 'NEW',
          mordecaiOperationalActive: false,
          nextActionAt: new Date(),
          meta,
        });
        created++;
      }
    }

    // Auto-enroll new/updated debt cases and recompute stages (early/mid/late) from DPD
    try {
      const automations = await automationService.list(tenantId, connectionId);
      for (const a of automations) {
        if (a.status !== 'active') continue;
        try {
          const result = await automationService.enroll(tenantId, a.id, {});
          if (result.enrolled > 0) {
            logger.info({ automationId: a.id, enrolled: result.enrolled }, 'Auto-enrolled cases after build-cases');
          }
          const stageResult = await automationService.recomputeStagesForAutomation(tenantId, a.id);
          if (stageResult.updated > 0) {
            logger.info({ automationId: a.id, updated: stageResult.updated }, 'Recomputed stages after build-cases');
          }
        } catch (err) {
          logger.warn({ err, automationId: a.id }, 'Auto-enroll/recompute after build-cases failed');
        }
      }
    } catch (err) {
      logger.warn({ err, connectionId, tenantId }, 'List automations for auto-enroll failed');
    }

    return {
      created,
      updated,
      total: created + updated,
      message: `Built ${created + updated} cases from PMS (${created} new, ${updated} updated).`,
    };
  },

  /**
   * Run full flow: sync (raw) -> refresh cases -> build new cases -> recompute stages.
   * Called by worker for sync-full-flow job. Does NOT create a job - runs inline.
   */
  runSyncFullFlow: async (tenantId, connectionId) => {
    await ensureTenant(tenantId);
    const connection = await propertyManagersService.getById(tenantId, connectionId);
    const software = await Software.findByPk(connection.softwareId);
    if (!software || !hasConnector(software.key)) {
      throw new BadRequestError('Connector not available for this connection');
    }

    const results = { sync: null, refresh: null, build: null, recompute: {} };

    try {
      results.sync = await runSync(connectionId, { trigger: 'manual' });
    } catch (err) {
      logger.error({ err, connectionId }, 'Sync full flow: sync step failed');
      await connection.update({ status: 'error', lastError: { message: err?.message } });
      throw err;
    }

    results.refresh = await refreshCasesFromPms(tenantId, connectionId);
    results.build = await buildNewCasesFromPms(tenantId, connectionId);

    const now = new Date();
    const automations = await automationService.list(tenantId, connectionId);
    for (const a of automations) {
      if (a.status !== 'active') continue;
      try {
        const stageResult = await automationService.recomputeStagesForAutomation(tenantId, a.id);
        results.recompute[a.id] = stageResult;
      } catch (err) {
        logger.warn({ err, automationId: a.id }, 'Recompute stages failed in sync full flow');
      }
    }

    const refreshed = await PmsConnection.findByPk(connectionId, { attributes: ['id', 'syncState'] });
    const prevSyncState = refreshed?.syncState ?? connection.syncState ?? {};
    await PmsConnection.update(
      {
        status: 'connected',
        lastSyncedAt: now,
        lastError: null,
        syncState: {
          ...prevSyncState,
          lastSuccessfulRunAt: now,
          lastRecomputeAt: now.toISOString(),
          lastRunStatus: 'SUCCESS',
          lastErrorMessage: null,
        },
      },
      { where: { id: connectionId } }
    );

    return results;
  },

  /**
   * @deprecated Use buildNewCasesFromPms. Kept for any legacy callers.
   */
  buildDebtCasesFromPms: async (tenantId, connectionId) => {
    const buildResult = await buildNewCasesFromPms(tenantId, connectionId);
    return {
      created: buildResult.created,
      updated: 0,
      total: buildResult.created,
      message: buildResult.message,
    };
  },

  /**
   * List pms_debtors for the tenant (synced from PMS). Optional filter by connectionId, search (name/email), sort.
   */
  listPmsDebtors: async (tenantId, opts = {}) => {
    await ensureTenant(tenantId);
    const limit = Math.min(Number(opts.limit) || 500, 1000);
    const offset = Number(opts.offset) || 0;
    const connectionId = opts.connectionId || null;
    const search = typeof opts.search === 'string' ? opts.search.trim() : null;
    const sortBy = opts.sortBy && ['displayName', 'email', 'createdAt'].includes(opts.sortBy) ? opts.sortBy : 'displayName';
    const sortOrder = opts.sortOrder === 'desc' ? 'DESC' : 'ASC';

    const where = { tenantId };
    if (connectionId) where.pmsConnectionId = connectionId;
    if (search && search.length > 0) {
      where[Op.or] = [
        { displayName: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const { rows, count } = await PmsDebtor.findAndCountAll({
      where,
      limit,
      offset,
      order: [[sortBy, sortOrder]],
      include: [
        {
          association: 'pmsConnection',
          attributes: ['id', 'status', 'lastSyncedAt'],
          include: [
            { association: 'software', attributes: ['key', 'name'] },
          ],
        },
      ],
    });

    return { data: rows, total: count, limit, offset };
  },

  /**
   * List pms_leases for the tenant. Optional filter by connectionId, search (leaseNumber/status), sort.
   */
  listPmsLeases: async (tenantId, opts = {}) => {
    await ensureTenant(tenantId);
    const limit = Math.min(Number(opts.limit) || 500, 1000);
    const offset = Number(opts.offset) || 0;
    const connectionId = opts.connectionId || null;
    const search = typeof opts.search === 'string' ? opts.search.trim() : null;
    const status = opts.status && ['active', 'ended', 'pending'].includes(opts.status) ? opts.status : null;
    const sortBy = opts.sortBy && ['leaseNumber', 'status', 'moveInDate', 'createdAt'].includes(opts.sortBy) ? opts.sortBy : 'leaseNumber';
    const sortOrder = opts.sortOrder === 'desc' ? 'DESC' : 'ASC';

    const where = { tenantId };
    if (connectionId) where.pmsConnectionId = connectionId;
    if (status) where.status = status;
    if (search && search.length > 0) {
      where[Op.or] = [
        { leaseNumber: { [Op.iLike]: `%${search}%` } },
        { status: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const { rows, count } = await PmsLease.findAndCountAll({
      where,
      limit,
      offset,
      order: [[sortBy, sortOrder]],
      include: [
        {
          association: 'pmsConnection',
          attributes: ['id', 'status', 'lastSyncedAt'],
          include: [{ association: 'software', attributes: ['key', 'name'] }],
        },
        {
          association: 'pmsDebtor',
          attributes: ['id', 'displayName', 'email'],
        },
      ],
    });

    return { data: rows, total: count, limit, offset };
  },

  /**
   * Stats for PM-Manager cards: counts (debtors, leases, charges, payments) and balances/aging summary.
   */
  getPmsStats: async (tenantId) => {
    await ensureTenant(tenantId);
    const [totalDebtors, totalLeases, totalUnits, totalPortfolios, totalCharges, totalPayments, balancesCount, latestSnapshot] = await Promise.all([
      PmsDebtor.count({ where: { tenantId } }),
      PmsLease.count({ where: { tenantId } }),
      PmsUnit.count({ where: { tenantId } }),
      PmsPortfolio.count({ where: { tenantId } }),
      ArCharge.count({ where: { tenantId } }),
      ArPayment.count({ where: { tenantId } }),
      ArBalance.count({ where: { tenantId } }),
      ArAgingSnapshot.findOne({
        where: { tenantId },
        order: [['asOfDate', 'DESC']],
        attributes: ['asOfDate', 'totalCents', 'bucket030Cents', 'bucket3160Cents', 'bucket6190Cents', 'bucket90PlusCents'],
      }),
    ]);
    const aging = latestSnapshot
      ? {
          asOfDate: latestSnapshot.asOfDate,
          totalCents: Number(latestSnapshot.totalCents) || 0,
          bucket030Cents: Number(latestSnapshot.bucket030Cents) || 0,
          bucket3160Cents: Number(latestSnapshot.bucket3160Cents) || 0,
          bucket6190Cents: Number(latestSnapshot.bucket6190Cents) || 0,
          bucket90PlusCents: Number(latestSnapshot.bucket90PlusCents) || 0,
        }
      : null;
    return {
      totalDebtors,
      totalLeases,
      totalUnits,
      totalPortfolios,
      totalCharges,
      totalPayments,
      totalBalanceCents: aging?.totalCents ?? 0,
      balancesCount,
      aging,
    };
  },

  /**
   * List pms_units for the tenant (synced from PMS). Optional filter by connectionId, propertyId, search (unitNumber).
   */
  listPmsUnits: async (tenantId, opts = {}) => {
    await ensureTenant(tenantId);
    const limit = Math.min(Number(opts.limit) || 500, 1000);
    const offset = Number(opts.offset) || 0;
    const connectionId = opts.connectionId || null;
    const propertyId = opts.propertyId || null;
    const search = typeof opts.search === 'string' ? opts.search.trim() : null;
    const sortBy = opts.sortBy && ['unitNumber', 'createdAt'].includes(opts.sortBy) ? opts.sortBy : 'unitNumber';
    const sortOrder = opts.sortOrder === 'desc' ? 'DESC' : 'ASC';

    const where = { tenantId };
    if (connectionId) where.pmsConnectionId = connectionId;
    if (propertyId) where.pmsPropertyId = propertyId;
    if (search && search.length > 0) {
      where.unitNumber = { [Op.iLike]: `%${search}%` };
    }

    const { rows, count } = await PmsUnit.findAndCountAll({
      where,
      limit,
      offset,
      order: [[sortBy, sortOrder]],
      include: [
        {
          association: 'pmsConnection',
          attributes: ['id', 'status', 'lastSyncedAt'],
          include: [{ association: 'software', attributes: ['key', 'name'] }],
        },
        {
          association: 'pmsProperty',
          attributes: ['id', 'name', 'externalId'],
          required: false,
          include: [
            { association: 'pmsPortfolio', attributes: ['id', 'name'], required: false },
          ],
        },
      ],
    });

    return { data: rows, total: count, limit, offset };
  },

  /**
   * List pms_portfolios for the tenant (synced from PMS). Optional filter by connectionId, search (name).
   */
  listPmsPortfolios: async (tenantId, opts = {}) => {
    await ensureTenant(tenantId);
    const limit = Math.min(Number(opts.limit) || 500, 1000);
    const offset = Number(opts.offset) || 0;
    const connectionId = opts.connectionId || null;
    const search = typeof opts.search === 'string' ? opts.search.trim() : null;
    const sortBy = opts.sortBy && ['name', 'createdAt'].includes(opts.sortBy) ? opts.sortBy : 'name';
    const sortOrder = opts.sortOrder === 'desc' ? 'DESC' : 'ASC';

    const where = { tenantId };
    if (connectionId) where.pmsConnectionId = connectionId;
    if (search && search.length > 0) {
      where.name = { [Op.iLike]: `%${search}%` };
    }

    const { rows, count } = await PmsPortfolio.findAndCountAll({
      where,
      limit,
      offset,
      order: [[sortBy, sortOrder]],
      include: [
        {
          association: 'pmsConnection',
          attributes: ['id', 'status', 'lastSyncedAt'],
          include: [{ association: 'software', attributes: ['key', 'name'] }],
        },
      ],
    });

    return { data: rows, total: count, limit, offset };
  },

  /**
   * List ar_charges for the tenant (paginated). Optional filter by connectionId, leaseId, sort.
   */
  listPmsCharges: async (tenantId, opts = {}) => {
    await ensureTenant(tenantId);
    const limit = Math.min(Number(opts.limit) || 50, 500);
    const offset = Number(opts.offset) || 0;
    const connectionId = opts.connectionId || null;
    const sortBy = opts.sortBy && ['dueDate', 'postDate', 'amountCents', 'createdAt'].includes(opts.sortBy) ? opts.sortBy : 'dueDate';
    const sortOrder = opts.sortOrder === 'asc' ? 'ASC' : 'DESC';

    const where = { tenantId };
    if (connectionId) where.pmsConnectionId = connectionId;

    const { rows, count } = await ArCharge.findAndCountAll({
      where,
      limit,
      offset,
      order: [[sortBy, sortOrder]],
      include: [
        {
          association: 'pmsLease',
          attributes: ['id', 'leaseNumber', 'status', 'externalId'],
          required: false,
          include: [
            { association: 'pmsDebtor', attributes: ['id', 'displayName', 'email'], required: false },
          ],
        },
      ],
    });

    return { data: rows, total: count, limit, offset };
  },

  /**
   * List ar_payments for the tenant (paginated). Optional filter by connectionId, sort.
   */
  listPmsPayments: async (tenantId, opts = {}) => {
    await ensureTenant(tenantId);
    const limit = Math.min(Number(opts.limit) || 50, 500);
    const offset = Number(opts.offset) || 0;
    const connectionId = opts.connectionId || null;
    const sortBy = opts.sortBy && ['paidAt', 'amountCents', 'createdAt'].includes(opts.sortBy) ? opts.sortBy : 'paidAt';
    const sortOrder = opts.sortOrder === 'asc' ? 'ASC' : 'DESC';

    const where = { tenantId };
    if (connectionId) where.pmsConnectionId = connectionId;

    const { rows, count } = await ArPayment.findAndCountAll({
      where,
      limit,
      offset,
      order: [[sortBy, sortOrder]],
      include: [
        {
          association: 'pmsLease',
          attributes: ['id', 'leaseNumber', 'status', 'externalId'],
          required: false,
          include: [
            { association: 'pmsDebtor', attributes: ['id', 'displayName', 'email'], required: false },
          ],
        },
        {
          association: 'pmsConnection',
          attributes: ['id'],
          required: false,
          include: [
            { association: 'software', attributes: ['name'], required: false },
          ],
        },
      ],
    });

    return { data: rows, total: count, limit, offset };
  },

  /**
   * Balances and aging summary for the tenant (lease-level balances + aging snapshot).
   */
  getPmsBalancesSummary: async (tenantId) => {
    await ensureTenant(tenantId);
    const latestSnapshot = await ArAgingSnapshot.findOne({
      where: { tenantId },
      order: [['asOfDate', 'DESC']],
      attributes: ['asOfDate', 'totalCents', 'bucket030Cents', 'bucket3160Cents', 'bucket6190Cents', 'bucket90PlusCents', 'currency'],
    });
    const asOfDate = latestSnapshot?.asOfDate ?? null;
    const latestDate = asOfDate;
    const leaseBalances = latestDate
      ? await ArBalance.findAll({
          where: { tenantId, asOfDate: latestDate },
          attributes: ['id', 'pmsLeaseId', 'balanceCents', 'asOfDate', 'currency'],
          include: [
            {
              association: 'pmsLease',
              attributes: ['id', 'leaseNumber', 'externalId'],
              required: false,
              include: [{ association: 'pmsDebtor', attributes: ['id', 'displayName'], required: false }],
            },
          ],
        })
      : [];

    const aging = latestSnapshot
      ? {
          asOfDate: latestSnapshot.asOfDate,
          totalCents: Number(latestSnapshot.totalCents) || 0,
          bucket030Cents: Number(latestSnapshot.bucket030Cents) || 0,
          bucket3160Cents: Number(latestSnapshot.bucket3160Cents) || 0,
          bucket6190Cents: Number(latestSnapshot.bucket6190Cents) || 0,
          bucket90PlusCents: Number(latestSnapshot.bucket90PlusCents) || 0,
          currency: latestSnapshot.currency || 'USD',
        }
      : null;

    return {
      asOfDate: latestDate,
      totalCents: aging?.totalCents ?? leaseBalances.reduce((s, b) => s + Number(b.balanceCents || 0), 0),
      currency: 'USD',
      aging,
      leaseBalances: leaseBalances.map((b) => {
        const plain = b.get ? b.get({ plain: true }) : b;
        return {
          id: plain.id,
          pmsLeaseId: plain.pmsLeaseId,
          balanceCents: Number(plain.balanceCents) || 0,
          asOfDate: plain.asOfDate,
          currency: plain.currency || 'USD',
          pmsLease: plain.pmsLease,
        };
      }),
    };
  },
};
