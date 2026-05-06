import { config } from '../../../config/index.js';
import { logger } from '../../../utils/logger.js';
import { InteractionLog } from '../../../models/index.js';
import { verifyVoiceContextSignature } from './context-signature.js';
import {
  registerCallForInteraction,
  resolveInteractionContext,
} from '../../elevenlabs/eleven.service.js';

const escapeXml = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const buildStreamUrl = () => {
  const directUrl = process.env.TWILIO_STREAM_URL;
  if (directUrl) return directUrl;

  const baseUrl = process.env.TWILIO_WEBHOOK_BASE_URL;
  if (!baseUrl) return null;

  const wsBase = baseUrl.replace(/^http/i, 'ws');
  return `${wsBase}/api/${config.app.apiVersion}/twilio/stream`;
};

const buildVoiceResponse = (streamUrl) => `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(streamUrl)}" />
  </Connect>
</Response>`;

const buildHangupResponse = (message = '') => `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${message ? `<Say>${escapeXml(message)}</Say>` : ''}
  <Hangup />
</Response>`;

const validateSignedInteractionContext = ({ interaction, query }) => {
  const signatureSecret = process.env.CALL_CONTEXT_HMAC_SECRET;
  if (!signatureSecret) return { valid: true };

  const interactionId = query.il || query.interaction_id;
  const signature = query.sig;
  const exp = query.exp;
  const version = query.v || '1';
  const caseId = interaction?.debtCaseId || interaction?.debtCase?.id;

  return verifyVoiceContextSignature({
    interactionId,
    tenantId: interaction?.tenantId,
    caseId,
    exp,
    version,
    signature,
    secret: signatureSecret,
  });
};

const handleElevenRegisterVoice = async (req, res) => {
  const interactionId = req.query.il || req.query.interaction_id;
  if (!interactionId) {
    res.type('text/xml');
    return res
      .status(200)
      .send(
        buildHangupResponse(
          'Sorry, this call could not be started due to missing context.'
        )
      );
  }

  const interaction = await resolveInteractionContext(interactionId);
  if (!interaction) {
    res.type('text/xml');
    return res
      .status(200)
      .send(buildHangupResponse('Sorry, this call could not be started.'));
  }

  const signatureValidation = validateSignedInteractionContext({
    interaction,
    query: req.query || {},
  });
  if (!signatureValidation.valid) {
    logger.warn(
      { interactionId, reason: signatureValidation.reason },
      'Rejected Twilio voice request with invalid context signature'
    );
    res.type('text/xml');
    return res
      .status(200)
      .send(buildHangupResponse('Sorry, this call could not be authenticated.'));
  }

  const callSid = req.body?.CallSid || req.query.call_sid || null;
  const twilioFrom = req.body?.From || null;
  const twilioTo = req.body?.To || interaction?.debtCase?.debtor?.phone || null;

  try {
    const t0 = Date.now();
    const { twiml } = await registerCallForInteraction({
      interactionId,
      twilioCallSid: callSid,
      twilioFrom,
      twilioTo,
    });
    const elapsedMs = Date.now() - t0;
    logger.info(
      {
        interactionId,
        callSid,
        elapsedMs,
        twimlChars: typeof twiml === 'string' ? twiml.length : 0,
        twimlPreview: typeof twiml === 'string' ? twiml.slice(0, 200) : null,
      },
      'Eleven register-call produced TwiML'
    );

    res.type('text/xml');
    return res.status(200).send(twiml);
  } catch (error) {
    logger.error(
      {
        err: error,
        interactionId,
        callSid,
        twilioFrom,
        twilioTo,
      },
      'Failed to register call with ElevenLabs; returning hangup TwiML'
    );
    res.type('text/xml');
    return res
      .status(200)
      .send(buildHangupResponse('Sorry, we could not connect this call.'));
  }
};

/**
 * Twilio status callback for outbound/inbound voice legs. Set StatusCallback on the Calls API
 * resource to: POST {TWILIO_WEBHOOK_BASE_URL}/api/v1/twilio/voice/status
 * so terminal failures (busy, no-answer, etc.) update interaction_logs instead of staying in_progress.
 */
const handleVoiceStatusCallback = async (req, res) => {
  try {
    const CallSid = req.body?.CallSid || req.query?.CallSid;
    const rawStatus = req.body?.CallStatus || req.query?.CallStatus;
    const CallStatus = rawStatus ? String(rawStatus).toLowerCase() : '';
    const CallDuration = req.body?.CallDuration ?? req.query?.CallDuration ?? null;
    const AnsweredBy = req.body?.AnsweredBy ?? req.query?.AnsweredBy ?? null;
    const From = req.body?.From ?? req.query?.From ?? null;
    const To = req.body?.To ?? req.query?.To ?? null;
    if (!CallSid || !CallStatus) {
      return res.status(200).end();
    }

    const interaction = await InteractionLog.findOne({
      where: { providerRef: CallSid, type: 'CALL' },
    });
    if (!interaction) {
      logger.warn({ CallSid }, 'Twilio voice status: no interaction_logs row for CallSid');
      return res.status(200).end();
    }

    // Always log lifecycle statuses for debugging early disconnects.
    logger.info(
      {
        CallSid,
        interactionId: interaction.id,
        CallStatus: rawStatus,
        CallDuration,
        AnsweredBy,
        From,
        To,
      },
      'Twilio voice status: callback received'
    );

    const st = String(interaction.status || '').toLowerCase();
    if (st === 'completed' || st === 'failed') {
      return res.status(200).end();
    }

    if (CallStatus === 'initiated' || CallStatus === 'ringing') {
      // Keep status as queued; just record timing.
      await interaction.update({
        startedAt: interaction.startedAt || new Date(),
      });
      return res.status(200).end();
    }

    // Twilio often reports answered legs as "in-progress" depending on the webhook/event.
    if (CallStatus === 'answered' || CallStatus === 'in-progress') {
      await interaction.update({
        status: 'in_progress',
        startedAt: interaction.startedAt || new Date(),
      });
      return res.status(200).end();
    }

    if (CallStatus === 'completed') {
      await interaction.update({
        status: 'completed',
        endedAt: interaction.endedAt || new Date(),
      });
      logger.info(
        { CallSid, interactionId: interaction.id, CallDuration, AnsweredBy },
        'Twilio voice status: call leg completed',
      );
      return res.status(200).end();
    }

    const terminalFailed = new Set(['busy', 'failed', 'no-answer', 'canceled', 'cancelled']);
    if (terminalFailed.has(CallStatus)) {
      await interaction.update({
        status: 'failed',
        outcome: CallStatus === 'no-answer' ? 'NO_ANSWER' : 'FAILED',
        endedAt: new Date(),
        error: {
          twilioCallStatus: rawStatus,
          source: 'twilio_voice_status_callback',
        },
      });
      logger.info(
        { CallSid, interactionId: interaction.id, CallStatus: rawStatus },
        'Twilio voice status: call leg ended with failure status',
      );
    }

    return res.status(200).end();
  } catch (error) {
    logger.error({ error }, 'Twilio voice status callback failed');
    return res.status(500).end();
  }
};

export const twilioCallsController = {
  voiceStatus: handleVoiceStatusCallback,

  voice: async (req, res, next) => {
    try {
      const engine = (process.env.TWILIO_ENGINE || 'realtime').toLowerCase();
      if (engine === 'eleven_register') {
        const startedAt = Date.now();
        const result = await handleElevenRegisterVoice(req, res);
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs > 2500) {
          logger.warn(
            { elapsedMs },
            'Twilio voice handler (eleven_register) responded slowly; may cause early disconnects'
          );
        }
        return result;
      }

      const streamUrl = buildStreamUrl();
      if (!streamUrl) {
        return res.status(500).json({
          success: false,
          message: 'Missing TWILIO_STREAM_URL or TWILIO_WEBHOOK_BASE_URL for Twilio streaming.',
        });
      }

      res.type('text/xml');
      return res.status(200).send(buildVoiceResponse(streamUrl));
    } catch (error) {
      logger.error({ error }, 'Twilio voice handler failed');
      return next(error);
    }
  },
};

