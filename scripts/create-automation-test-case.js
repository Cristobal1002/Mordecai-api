/**
 * Create a test case and enroll it in an automation.
 * Use your own email/phone to receive test SMS, emails, etc.
 *
 * Usage:
 *   node scripts/create-automation-test-case.js <automation-id> [options]
 *
 * Example (QA):
 *   node scripts/create-automation-test-case.js 89727e95-9728-4f27-9f49-13744ca1e8da \
 *     --name "Tu Nombre" \
 *     --email "tu@email.com" \
 *     --phone "+56912345678" \
 *     --amount 500 \
 *     --days-past-due 12
 *
 * Prerequisites:
 *   - DB connection: point .env to QA DB or run with:
 *     DB_HOST=... DB_PORT=5432 DB_NAME=... DB_USER=... DB_PASSWORD=... node scripts/...
 *   - Automation must exist and have a strategy with stages
 */
import 'dotenv/config';
import { loadDatabase } from '../src/loaders/sequelize.load.js';
import {
  CollectionAutomation,
  DebtCase,
  Debtor,
  CollectionStage,
  CollectionStrategy,
} from '../src/models/index.js';
import { automationService } from '../src/modules/automations/automation.service.js';

const rawArgs = process.argv.slice(2);
const automationId = rawArgs[0] && !rawArgs[0].startsWith('--') ? rawArgs[0] : null;
const args = rawArgs[0] && !rawArgs[0].startsWith('--') ? rawArgs.slice(1) : rawArgs;

function parseArgs() {
  const opts = {
    name: 'Test Debtor',
    email: null,
    phone: null,
    amount: 500, // USD
    daysPastDue: 12,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) {
      opts.name = args[++i];
    } else if (args[i] === '--email' && args[i + 1]) {
      opts.email = args[++i];
    } else if (args[i] === '--phone' && args[i + 1]) {
      opts.phone = args[++i];
    } else if (args[i] === '--amount' && args[i + 1]) {
      opts.amount = parseFloat(args[++i]) || 500;
    } else if (args[i] === '--days-past-due' && args[i + 1]) {
      opts.daysPastDue = parseInt(args[++i], 10) || 12;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Create a test case for an automation (with your data for testing).

Usage:
  node scripts/create-automation-test-case.js <automation-id> [options]

Options:
  --name "Your Name"       Debtor full name (default: Test Debtor)
  --email "you@email.com"  Your email (to receive test emails)
  --phone "+56912345678"   Your phone (to receive test SMS/calls)
  --amount 500             Amount due in USD (default: 500)
  --days-past-due 12       Days past due (default: 12, must match a strategy stage)

Example:
  node scripts/create-automation-test-case.js 89727e95-9728-4f27-9f49-13744ca1e8da \\
    --name "Cristobal" --email "tu@email.com" --phone "+56912345678"
`);
      process.exit(0);
    }
  }
  return opts;
}

async function main() {
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    parseArgs(); // prints help and exits
    return;
  }

  const opts = parseArgs();

  if (!automationId) {
    console.error('Usage: node scripts/create-automation-test-case.js <automation-id> [--name ... --email ... --phone ...]');
    console.error('Run with --help for full options.');
    process.exit(1);
  }

  if (!opts.email && !opts.phone) {
    console.error('At least one of --email or --phone is required to receive test messages.');
    process.exit(1);
  }

  await loadDatabase();

  const automation = await CollectionAutomation.findOne({
    where: { id: automationId },
    include: [
      { model: CollectionStrategy, as: 'strategy', include: [{ model: CollectionStage, as: 'stages' }] },
    ],
  });

  if (!automation) {
    console.error('Automation not found:', automationId);
    process.exit(1);
  }

  const tenantId = automation.tenantId ?? automation.tenant_id;
  const strategy = automation.strategy;
  const stages = strategy?.stages ?? [];

  if (stages.length === 0) {
    console.error('Automation strategy has no stages. Add stages first.');
    process.exit(1);
  }

  const dpd = opts.daysPastDue;
  const validStage = stages.find(
    (s) =>
      dpd >= Number(s.minDaysPastDue) &&
      (s.maxDaysPastDue == null || dpd <= Number(s.maxDaysPastDue))
  );
  if (!validStage) {
    const ranges = stages.map((s) => `${s.minDaysPastDue}-${s.maxDaysPastDue ?? '∞'}`).join(', ');
    console.error(`days-past-due ${dpd} does not match any stage. Valid ranges: ${ranges}`);
    process.exit(1);
  }

  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() - dpd);
  const dueDateStr = dueDate.toISOString().slice(0, 10);

  const amountCents = Math.round(opts.amount * 100);

  const debtor = await Debtor.create({
    tenantId,
    fullName: opts.name,
    email: opts.email,
    phone: opts.phone,
    metadata: { source: 'test-case-script', createdAt: new Date().toISOString() },
  });

  const debtCase = await DebtCase.create({
    tenantId,
    debtorId: debtor.id,
    amountDueCents: amountCents,
    currency: 'USD',
    daysPastDue: dpd,
    dueDate: dueDateStr,
    status: 'NEW',
    mordecaiOperationalActive: true,
    approvalStatus: 'APPROVED',
    nextActionAt: new Date(),
    meta: {
      source: 'test-case-script',
      notes: 'Caso de prueba para automation',
      balance_type: 'rent',
      customer_name: opts.name,
    },
  });

  console.log('\nCreated:');
  console.log('  Debtor:', debtor.id, '-', opts.name, opts.email || opts.phone);
  console.log('  Debt case:', debtCase.id, '-', opts.amount, 'USD,', dpd, 'days past due');

  const result = await automationService.enroll(tenantId, automationId, {
    debtCaseIds: [debtCase.id],
  });

  console.log('\nEnrollment:', result);
  if (result.enrolled > 0) {
    console.log('\n✓ Test case enrolled in automation.');
    console.log('  View at: https://qa.mordecaitech.com/automations/' + automationId);
    console.log('  You should receive messages at:', opts.email || opts.phone);
  } else {
    console.log('\n⚠ Case was not enrolled. Check logs.');
    if (result.errors?.length) {
      console.log('  Errors:', result.errors);
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
