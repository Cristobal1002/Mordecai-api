/**
 * Crea un debt case de demo e inscribe en una automation específica.
 *
 * Usage:
 *   node scripts/seed-demo-case-into-automation.js [automation-id]
 *
 * Si no se pasa automation-id, usa: 89727e95-9728-4f27-9f49-13744ca1e8da
 *
 * Prerequisites:
 *   - DB con la automation existente (y su tenant, strategy, stages)
 *   - La automation debe tener strategy con al menos un stage
 */
import 'dotenv/config';
import { loadDatabase } from '../src/loaders/sequelize.load.js';
import {
  CollectionAutomation,
  DebtCase,
  Debtor,
  FlowPolicy,
} from '../src/models/index.js';
import { automationService } from '../src/modules/automations/automation.service.js';

const DEFAULT_AUTOMATION_ID = '89727e95-9728-4f27-9f49-13744ca1e8da';

/** Demo profile — edit here before running. amountDueCents = dollars * 100 (e.g. $3,500 → 350000). */
const DEMO = {
  debtor: {
    fullName: 'Cristobal Sosa',
    email: 'cristobal1002@gmail.com',
    phone: '+573165121606',
  },
  case: {
    /** USD 3,500.00 */
    amountDueCents: 350_000,
    currency: 'USD',
    /** Ajusta si quieres otra mora / vencimiento para el demo */
    daysPastDue: 15,
    meta: {
      notes: 'Demo seed — automation',
      lease_id: '001',
      unit_number: '210',
      balance_type: 'rent',
    },
  },
};

async function main() {
  const automationId = process.argv[2] || DEFAULT_AUTOMATION_ID;

  await loadDatabase();

  const automation = await CollectionAutomation.findByPk(automationId);

  if (!automation) {
    console.error('Automation not found:', automationId);
    process.exit(1);
  }

  const tenantId = automation.tenantId;
  const flowPolicy = await FlowPolicy.findOne({
    where: { tenantId },
    order: [['createdAt', 'ASC']],
  });

  const due = new Date();
  due.setDate(due.getDate() - DEMO.case.daysPastDue);

  const debtor = await Debtor.create({
    tenantId,
    fullName: DEMO.debtor.fullName,
    email: DEMO.debtor.email,
    phone: DEMO.debtor.phone,
    metadata: { notes: 'Synthetic demo debtor for automation testing' },
  });

  const debtCase = await DebtCase.create({
    tenantId,
    debtorId: debtor.id,
    flowPolicyId: flowPolicy?.id ?? null,
    amountDueCents: DEMO.case.amountDueCents,
    currency: DEMO.case.currency,
    daysPastDue: DEMO.case.daysPastDue,
    dueDate: due.toISOString().slice(0, 10),
    status: 'NEW',
    mordecaiOperationalActive: true,
    approvalStatus: 'APPROVED',
    meta: DEMO.case.meta,
  });

  const { enrolled, skipped, total } = await automationService.enroll(tenantId, automationId, {
    debtCaseIds: [debtCase.id],
  });

  console.log('\n--- Demo case creado e inscrito ---');
  console.log('Automation:', automationId);
  console.log('Tenant:', tenantId);
  console.log('Debtor:', debtor.id);
  console.log('Debt case:', debtCase.id);
  console.log('Enroll result: enrolled=%d, skipped=%d, total=%d', enrolled, skipped, total);
  console.log('\n---\n');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
