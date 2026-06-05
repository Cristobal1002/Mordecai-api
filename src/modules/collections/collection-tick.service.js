/**
 * Collections Engine v2 - Tick: recompute stages, then evaluate active automations, update case states, dispatch channels.
 * Called by a recurring job (every 15 min).
 */
import { Op } from 'sequelize';
import {
  CollectionAutomation,
  CollectionStrategy,
  CollectionStage,
  CaseAutomationState,
  CollectionEvent,
  DebtCase,
  Debtor,
  CaseDispute,
} from '../../models/index.js';
import { automationService } from '../automations/automation.service.js';
import { resolveChannelTemplate } from '../templates/template-resolution.service.js';
import { logger } from '../../utils/logger.js';
import {
  addCaseActionJob,
  CASE_ACTION_JOB_TYPES,
} from '../../queues/case-actions.queue.js';

const TICK_INTERVAL_MS = 15 * 60 * 1000; // 15 min
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function parseTimeWindow(windowStr) {
  if (!windowStr || typeof windowStr !== 'string') return null;
  const parts = windowStr.split('-').map((s) => s.trim());
  if (parts.length !== 2) return null;
  const [start, end] = parts.map((p) => {
    const [h, m] = p.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  });
  return { startMinutes: start, endMinutes: end };
}

function isInTimeWindow(now, window) {
  if (!window) return true;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (window.startMinutes <= window.endMinutes) {
    return minutes >= window.startMinutes && minutes <= window.endMinutes;
  }
  return minutes >= window.startMinutes || minutes <= window.endMinutes;
}

const CHANNEL_ORDER = ['call', 'sms', 'email', 'whatsapp'];

const resolveDispatchChannels = (channels = {}) =>
  CHANNEL_ORDER.filter((channel) => channels[channel] === true);

const resolveMissingTemplateMessage = (channel, reason) => {
  if (reason === 'stage_template_not_found') {
    return `${channel.toUpperCase()} template configured in stage was not found or is inactive`;
  }
  return `${channel.toUpperCase()} template is not configured for this stage`;
};

/**
 * Run one tick: recompute stages (DPD changes), then process all active automations and their due cases.
 */
export async function runCollectionTick() {
  const now = new Date();
  const automations = await CollectionAutomation.findAll({
    where: { status: 'active' },
    include: [{ model: CollectionStrategy, as: 'strategy', required: true }],
  });

  for (const automation of automations) {
    try {
      await automationService.recomputeStagesForAutomation(automation.tenantId, automation.id);
    } catch (err) {
      logger.warn({ err, automationId: automation.id }, 'Recompute stages failed in tick');
    }
  }

  let totalProcessed = 0;
  let totalEvents = 0;

  for (const automation of automations) {
    try {
      const strategy = automation.strategy;
      const cooldownHours = strategy.cooldownHours ?? 24;
      const cooldownMs = cooldownHours * 60 * 60 * 1000;
      const timeWindow = parseTimeWindow(strategy.allowedTimeWindow);
      const maxAttemptsPerWeek = strategy.maxAttemptsPerWeek ?? 999;
      const stopOnPromise = strategy.stopOnPromise !== false;
      const stopOnPayment = strategy.stopOnPayment !== false;

      const dueStates = await CaseAutomationState.findAll({
        where: {
          automationId: automation.id,
          status: 'active',
          nextActionAt: { [Op.lte]: now, [Op.ne]: null },
        },
        include: [
          {
            model: DebtCase,
            as: 'debtCase',
            required: true,
            where: { mordecaiOperationalActive: true },
            include: [{ model: Debtor, as: 'debtor', required: false }],
          },
          {
            model: CollectionStage,
            as: 'currentStage',
            required: false,
          },
        ],
        limit: 100,
      });

      const debtCaseIds = dueStates.map((s) => s.debtCaseId);
      const openDisputeCaseIds = new Set(
        debtCaseIds.length > 0
          ? (await CaseDispute.findAll({
              where: { debtCaseId: { [Op.in]: debtCaseIds }, status: 'OPEN' },
              attributes: ['debtCaseId'],
              raw: true,
            })).map((r) => r.debt_case_id)
          : []
      );

      for (const state of dueStates) {
        if (!isInTimeWindow(now, timeWindow)) continue;

        if ((state.debtCase?.approvalStatus ?? state.debtCase?.approval_status) !== 'APPROVED') {
          await CollectionEvent.create({
            automationId: automation.id,
            debtCaseId: state.debtCaseId,
            channel: null,
            eventType: 'dispatch_skipped_approval_pending',
            payload: { reason: 'Case requires approval before execution' },
          });
          continue;
        }

        if (openDisputeCaseIds.has(state.debtCaseId)) {
          await CollectionEvent.create({
            automationId: automation.id,
            debtCaseId: state.debtCaseId,
            channel: null,
            eventType: 'dispatch_skipped_open_dispute',
            payload: { reason: 'Case has an open dispute' },
          });
          continue;
        }

        let attemptsWeekCount = state.attemptsWeekCount ?? 0;
        if (state.lastAttemptAt && now - new Date(state.lastAttemptAt) > WEEK_MS) {
          attemptsWeekCount = 0;
        }
        if (attemptsWeekCount >= maxAttemptsPerWeek) continue;

        if (stopOnPromise && state.promiseDueDate) {
          const due = new Date(state.promiseDueDate);
          if (due > now) continue;
        }

        if (state.lastAttemptAt && now - new Date(state.lastAttemptAt) < cooldownMs) continue;

        const nextActionAt = new Date(now.getTime() + cooldownMs);
        const stage = state.currentStage || null;
        const dispatchChannels = resolveDispatchChannels(stage?.channels || {});
        const outcomes = [];

        if (dispatchChannels.length === 0) {
          await CollectionEvent.create({
            automationId: automation.id,
            debtCaseId: state.debtCaseId,
            channel: null,
            eventType: 'dispatch_skipped_no_channel',
            payload: {
              stageId: stage?.id || null,
              channels: stage?.channels || {},
              reason: 'No channel enabled in stage',
            },
          });
          outcomes.push('dispatch_skipped_no_channel');
        } else {
          for (const dispatchChannel of dispatchChannels) {
            if (dispatchChannel === 'call') {
              const jobId = await addCaseActionJob(CASE_ACTION_JOB_TYPES.CALL_CASE, {
                tenantId: automation.tenantId,
                caseId: state.debtCaseId,
                automationId: automation.id,
                stateId: state.id,
              });

              if (!jobId) {
                outcomes.push('call_dispatch_queue_unavailable');
                await CollectionEvent.create({
                  automationId: automation.id,
                  debtCaseId: state.debtCaseId,
                  channel: 'call',
                  eventType: 'call_dispatch_queue_unavailable',
                  payload: {
                    reason: 'REDIS queue unavailable (missing REDIS_URL or queue init failed)',
                  },
                });
              } else {
                outcomes.push('call_queued');
                await CollectionEvent.create({
                  automationId: automation.id,
                  debtCaseId: state.debtCaseId,
                  channel: 'call',
                  eventType: 'call_queued',
                  payload: {
                    jobId,
                  },
                });
              }
              continue;
            }

            if (dispatchChannel === 'sms') {
              const smsTemplate = await resolveChannelTemplate({
                tenantId: automation.tenantId,
                channel: 'sms',
                stage,
              });
              if (!smsTemplate.template) {
                outcomes.push('sms_skipped_missing_template');
                await CollectionEvent.create({
                  automationId: automation.id,
                  debtCaseId: state.debtCaseId,
                  channel: 'sms',
                  eventType: 'sms_skipped_missing_template',
                  payload: {
                    reason: resolveMissingTemplateMessage('sms', smsTemplate.reason),
                    templateReason: smsTemplate.reason,
                    stageId: stage?.id || null,
                  },
                });
                continue;
              }

              const jobId = await addCaseActionJob(CASE_ACTION_JOB_TYPES.SMS_CASE, {
                tenantId: automation.tenantId,
                caseId: state.debtCaseId,
                automationId: automation.id,
                stateId: state.id,
              });

              if (!jobId) {
                outcomes.push('sms_dispatch_queue_unavailable');
                await CollectionEvent.create({
                  automationId: automation.id,
                  debtCaseId: state.debtCaseId,
                  channel: 'sms',
                  eventType: 'sms_dispatch_queue_unavailable',
                  payload: {
                    reason: 'REDIS queue unavailable (missing REDIS_URL or queue init failed)',
                  },
                });
              } else {
                outcomes.push('sms_queued');
                await CollectionEvent.create({
                  automationId: automation.id,
                  debtCaseId: state.debtCaseId,
                  channel: 'sms',
                  eventType: 'sms_queued',
                  payload: {
                    jobId,
                  },
                });
              }
              continue;
            }

            if (dispatchChannel === 'email') {
              const emailTemplate = await resolveChannelTemplate({
                tenantId: automation.tenantId,
                channel: 'email',
                stage,
              });
              if (!emailTemplate.template) {
                outcomes.push('email_skipped_missing_template');
                await CollectionEvent.create({
                  automationId: automation.id,
                  debtCaseId: state.debtCaseId,
                  channel: 'email',
                  eventType: 'email_skipped_missing_template',
                  payload: {
                    reason: resolveMissingTemplateMessage('email', emailTemplate.reason),
                    templateReason: emailTemplate.reason,
                    stageId: stage?.id || null,
                  },
                });
                continue;
              }

              const jobId = await addCaseActionJob(CASE_ACTION_JOB_TYPES.EMAIL_CASE, {
                tenantId: automation.tenantId,
                caseId: state.debtCaseId,
                automationId: automation.id,
                stateId: state.id,
              });

              if (!jobId) {
                outcomes.push('email_dispatch_queue_unavailable');
                await CollectionEvent.create({
                  automationId: automation.id,
                  debtCaseId: state.debtCaseId,
                  channel: 'email',
                  eventType: 'email_dispatch_queue_unavailable',
                  payload: {
                    reason: 'REDIS queue unavailable (missing REDIS_URL or queue init failed)',
                  },
                });
              } else {
                outcomes.push('email_queued');
                await CollectionEvent.create({
                  automationId: automation.id,
                  debtCaseId: state.debtCaseId,
                  channel: 'email',
                  eventType: 'email_queued',
                  payload: {
                    jobId,
                  },
                });
              }
              continue;
            }

            outcomes.push('dispatch_skipped_not_implemented');
            await CollectionEvent.create({
              automationId: automation.id,
              debtCaseId: state.debtCaseId,
              channel: dispatchChannel,
              eventType: 'dispatch_skipped_not_implemented',
              payload: {
                stageId: stage?.id || null,
                reason: `Channel "${dispatchChannel}" not implemented`,
              },
            });
          }
        }

        const outcome =
          outcomes.length > 0 ? outcomes.join(',') : 'tick_eligible';

        await state.update({
          lastAttemptAt: now,
          nextActionAt,
          attemptsWeekCount: attemptsWeekCount + 1,
          lastOutcome: outcome,
          lastOutcomeAt: now,
        });

        totalProcessed++;
        totalEvents += Math.max(outcomes.length, 1);
      }

      await automation.update({
        lastEvaluatedAt: now,
        nextTickAt: new Date(now.getTime() + TICK_INTERVAL_MS),
      });
    } catch (err) {
      logger.error({ err, automationId: automation.id }, 'Collection tick: error processing automation');
    }
  }

  if (totalProcessed > 0) {
    logger.info(
      { totalProcessed, totalEvents, automationsCount: automations.length },
      'Collection tick completed'
    );
  }
  return { processed: totalProcessed, events: totalEvents, automations: automations.length };
}
