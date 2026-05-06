/**
 * Case actions queue shared with mordecai-workers.
 * Supports on-demand and automation-driven actions.
 */
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { logger } from '../utils/logger.js';
import { withBullmqPrefix } from './bullmq-queue-options.js';

export const CASE_ACTIONS_QUEUE_NAME = 'case-actions';

export const CASE_ACTION_JOB_TYPES = {
  CALL_CASE: 'CALL_CASE',
  SMS_CASE: 'SMS_CASE',
  EMAIL_CASE: 'EMAIL_CASE',
  SYNC_CALL_SUMMARY: 'SYNC_CALL_SUMMARY',
};

// Backward compatibility for older imports
export const JOB_TYPES = CASE_ACTION_JOB_TYPES;

let connection = null;
let queue = null;

function getConnection() {
  if (connection) return connection;

  const url = process.env.REDIS_URL?.trim();
  if (!url) return null;

  connection = new IORedis(url, { maxRetriesPerRequest: null });
  connection.on('error', (err) =>
    logger.error({ err }, 'Case actions queue Redis error')
  );

  return connection;
}

export function getCaseActionsQueue() {
  if (queue) return queue;

  const conn = getConnection();
  if (!conn) return null;

  queue = new Queue(
    CASE_ACTIONS_QUEUE_NAME,
    withBullmqPrefix({ connection: conn })
  );
  return queue;
}

export async function addCaseActionJob(jobName, data, options = {}) {
  const q = getCaseActionsQueue();
  if (!q) return null;

  const job = await q.add(jobName, data, {
    attempts: Number(process.env.WORKER_ATTEMPTS) || 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
    ...options,
  });

  return job.id;
}

/**
 * On-demand call helper (used by cases module)
 */
export async function addCallCaseJob(tenantId, caseId, options = {}) {
  const jobId = `CALL_CASE-on-demand-${caseId}-${Date.now()}`;
  const followUp = Boolean(options.followUp);

  const id = await addCaseActionJob(
    CASE_ACTION_JOB_TYPES.CALL_CASE,
    { tenantId, caseId, followUp },
    { jobId }
  );

  if (id) {
    logger.info(
      { tenantId, caseId, jobId: id },
      'On-demand call job enqueued'
    );
  }

  return id;
}
