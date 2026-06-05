import { CALL_STATES } from "../call-state-machine.js";
import { NEGOTIATION_CALENDAR_TZ } from "../negotiation-first-payment-window.service.js";
import { normalizePlanCode } from "../policy/plan-catalog.service.js";

const DELIVERY_CHANNEL_VALUES = new Set(["email", "sms", "both"]);

const DISPUTE_REASON_ALIASES = Object.freeze({
  PAID_ALREADY: new Set([
    "paid",
    "paid_already",
    "already_paid",
    "payment_made",
    "settled",
  ]),
  WRONG_AMOUNT: new Set([
    "wrong_amount",
    "incorrect_amount",
    "amount_wrong",
    "incorrect_balance",
  ]),
  WRONG_DEBTOR: new Set([
    "wrong_debtor",
    "wrong_person",
    "not_mine",
    "not_me",
    "identity_issue",
    "fraud",
  ]),
  LEASE_ENDED: new Set(["lease_ended", "moved_out", "no_longer_tenant"]),
  UNDER_LEGAL_REVIEW: new Set([
    "legal",
    "under_legal_review",
    "attorney",
    "court",
  ]),
  PROMISE_OFFLINE: new Set(["promise_offline", "offline_promise"]),
  DO_NOT_CONTACT: new Set(["do_not_contact", "stop_contact", "stop_calling"]),
  OTHER: new Set(["other"]),
});

const DISPUTE_REASON_VALUES = new Set(Object.keys(DISPUTE_REASON_ALIASES));

const normalizeText = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();

const normalizeYmd = (raw) => {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/**
 * Prefer ISO YYYY-MM-DD; US-style M/D/YYYY (or M-D-YYYY) for numeric dates; English month names
 * and ordinals ("May 15th", "the 15th"). "Today" for relative parsing uses NEGOTIATION_CALENDAR_TZ
 * (see AGREEMENT_INSTALLMENT_CALENDAR_TZ) so it matches the negotiation window, not the server's UTC day.
 *
 * Known limitation: slash dates are interpreted as US MM/DD/YYYY. Latin DD/MM with both parts ≤ 12
 * can resolve to the wrong calendar day; acceptable while the product is US-first.
 */
const MONTH_NAMES = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
  // Spanish (common in calls even for US tenants)
  enero: 1, ene: 1,
  febrero: 2, feb: 2,
  marzo: 3, mar: 3,
  abril: 4, abr: 4,
  mayo: 5, may: 5,
  junio: 6, jun: 6,
  julio: 7, jul: 7,
  agosto: 8, ago: 8,
  septiembre: 9, setiembre: 9, sep: 9, sept: 9,
  octubre: 10, oct: 10,
  noviembre: 11, nov: 11,
  diciembre: 12, dic: 12,
};

const getNegotiationCalendarTodayParts = () => {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: NEGOTIATION_CALENDAR_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
  return { currentYear: y, currentMonth: m, todayDay: d };
};

const getNegotiationTodayYmd = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: NEGOTIATION_CALENDAR_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

/** Tomorrow YYYY-MM-DD in negotiation TZ (calendar day, not UTC day). */
const getNegotiationTomorrowYmd = () => {
  const today = getNegotiationTodayYmd();
  const [y, m, d] = today.split("-").map((x) => parseInt(x, 10));
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
};

const getNegotiationTodayWeekdayIndex = () => {
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: NEGOTIATION_CALENDAR_TZ,
    weekday: "short",
  }).format(new Date());
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd] ?? null;
};

const addDaysToNegotiationTodayYmd = (daysToAdd) => {
  const today = getNegotiationTodayYmd();
  const [y, m, d] = today.split("-").map((x) => parseInt(x, 10));
  const next = new Date(Date.UTC(y, m - 1, d + Number(daysToAdd || 0)));
  return next.toISOString().slice(0, 10);
};

const getLastCalendarDayOfCurrentMonthYmd = () => {
  const { currentYear: y, currentMonth: m } = getNegotiationCalendarTodayParts();
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
  const lastD = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(lastD).padStart(2, "0")}`;
};

const withinCurrentMonthCap = (ymd) => {
  const cap = getLastCalendarDayOfCurrentMonthYmd();
  if (!cap || !ymd) return false;
  return String(ymd) <= String(cap);
};

/** Reject impossible dates (e.g. Feb 31) — JS Date rolls over silently. */
const ymdIfValidCalendar = (year, month, day) => {
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    year < 2000 ||
    year > 2100
  ) {
    return null;
  }
  const dt = new Date(year, month - 1, day);
  if (
    dt.getFullYear() !== year ||
    dt.getMonth() !== month - 1 ||
    dt.getDate() !== day
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

const extractFirstDueDateFromText = (text) => {
  const s = String(text || "").trim();
  const { currentYear, currentMonth, todayDay } = getNegotiationCalendarTodayParts();

  // ISO: YYYY-MM-DD
  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const ymd = ymdIfValidCalendar(
      parseInt(iso[1], 10),
      parseInt(iso[2], 10),
      parseInt(iso[3], 10),
    );
    if (ymd) return ymd;
  }

  // US: MM/DD/YYYY (or MM-DD-YYYY). DD/MM can be wrong when both ≤ 12 — see module comment.
  const slashFull = s.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  if (slashFull) {
    const month = parseInt(slashFull[1], 10);
    const day = parseInt(slashFull[2], 10);
    const year = parseInt(slashFull[3], 10);
    const ymd = ymdIfValidCalendar(year, month, day);
    if (ymd) return ymd;
  }

  const lower = s.toLowerCase();

  // Relative dates (explicit, common in calls)
  if (/\b(today)\b/.test(lower) || /\b(hoy)\b/.test(lower)) {
    const ymd = getNegotiationTodayYmd();
    return withinCurrentMonthCap(ymd) ? ymd : null;
  }
  if (/\b(tomorrow)\b/.test(lower) || /\b(mañana)\b/.test(lower) || /\b(manana)\b/.test(lower)) {
    const ymd = getNegotiationTomorrowYmd();
    return withinCurrentMonthCap(ymd) ? ymd : null;
  }
  // "in 3 days" / "in three days" (we only support numeric); Spanish "en 3 dias"
  const inDays = lower.match(/\bin\s+(\d{1,3})\s+day(?:s)?\b/);
  if (inDays) {
    const n = Math.max(0, Math.min(365, parseInt(inDays[1], 10)));
    const ymd = addDaysToNegotiationTodayYmd(n);
    return withinCurrentMonthCap(ymd) ? ymd : null;
  }
  const enDias = lower.match(/\ben\s+(\d{1,3})\s+d[ií]a(?:s)?\b/);
  if (enDias) {
    const n = Math.max(0, Math.min(365, parseInt(enDias[1], 10)));
    const ymd = addDaysToNegotiationTodayYmd(n);
    return withinCurrentMonthCap(ymd) ? ymd : null;
  }

  // Weekday relative: "next tuesday", "next tue", Spanish "el próximo martes"
  const WEEKDAYS = {
    sunday: 0, sun: 0, domingo: 0, dom: 0,
    monday: 1, mon: 1, lunes: 1, lun: 1,
    tuesday: 2, tue: 2, tues: 2, martes: 2, mar: 2,
    wednesday: 3, wed: 3, miercoles: 3, miércoles: 3, mie: 3, mié: 3,
    thursday: 4, thu: 4, thur: 4, thurs: 4, jueves: 4, jue: 4,
    friday: 5, fri: 5, viernes: 5, vie: 5,
    saturday: 6, sat: 6, sabado: 6, sábado: 6, sab: 6, sáb: 6,
  };
  const weekdayKeys = Object.keys(WEEKDAYS).join("|");
  const nextWeekday = lower.match(new RegExp(`\\b(?:next|pr[oó]ximo)\\s+(${weekdayKeys})\\b`, "i"));
  if (nextWeekday) {
    const target = WEEKDAYS[String(nextWeekday[1] || "").toLowerCase()];
    const todayW = getNegotiationTodayWeekdayIndex();
    if (target != null && todayW != null) {
      let delta = (target - todayW + 7) % 7;
      if (delta === 0) delta = 7;
      const ymd = addDaysToNegotiationTodayYmd(delta);
      return withinCurrentMonthCap(ymd) ? ymd : null;
    }
  }

  // Spanish: "15 de mayo", "el 15 de mayo", optional year.
  // Keep this before month-name English patterns so it wins when "de" is present.
  const monthNamesAll = Object.keys(MONTH_NAMES).join("|");
  const dayDeMonth = new RegExp(
    `\\b(?:el\\s+)?(\\d{1,2})(?:\\s+de\\s+)?(${monthNamesAll})(?:\\s+(\\d{4}))?\\b`,
    "i",
  );
  const mdm = lower.match(dayDeMonth);
  if (mdm) {
    const day = parseInt(mdm[1], 10);
    const month = MONTH_NAMES[mdm[2].toLowerCase()];
    const year = mdm[3]
      ? parseInt(mdm[3], 10)
      : month < currentMonth
        ? currentYear + 1
        : currentYear;
    if (month) {
      const ymd = ymdIfValidCalendar(year, month, day);
      if (ymd) return ymd;
    }
  }

  // "May 15", "May 15th", "15th of May", "15 May"
  const monthThenDay = new RegExp(`\\b(${monthNamesAll})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(\\d{4}))?\\b`, "i");
  const dayThenMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthNamesAll})(?:\\s+(\\d{4}))?\\b`, "i");

  const m1 = lower.match(monthThenDay);
  if (m1) {
    const month = MONTH_NAMES[m1[1].toLowerCase()];
    const day = parseInt(m1[2], 10);
    const year = m1[3]
      ? parseInt(m1[3], 10)
      : month < currentMonth
        ? currentYear + 1
        : currentYear;
    if (month) {
      const ymd = ymdIfValidCalendar(year, month, day);
      if (ymd) return ymd;
    }
  }

  const m2 = lower.match(dayThenMonth);
  if (m2) {
    const day = parseInt(m2[1], 10);
    const month = MONTH_NAMES[m2[2].toLowerCase()];
    const year = m2[3]
      ? parseInt(m2[3], 10)
      : month < currentMonth
        ? currentYear + 1
        : currentYear;
    if (month) {
      const ymd = ymdIfValidCalendar(year, month, day);
      if (ymd) return ymd;
    }
  }

  // "the 15th", "on the 10th", Spanish "el 15" — use current or next month context
  const ordinalOnly =
    lower.match(/\bthe\s+(\d{1,2})(?:st|nd|rd|th)?\b/) ||
    lower.match(/\bel\s+(\d{1,2})\b/);
  if (!ordinalOnly) {
    const bareOrdinal = lower.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/);
    if (bareOrdinal) {
      const day = parseInt(bareOrdinal[1], 10);
      if (day >= 1 && day <= 31) {
        const useNextMonth = day < todayDay;
        const month = useNextMonth ? (currentMonth % 12) + 1 : currentMonth;
        const year =
          useNextMonth && currentMonth === 12 ? currentYear + 1 : currentYear;
        const ymd = ymdIfValidCalendar(year, month, day);
        if (ymd) return ymd;
      }
    }
  } else {
    const day = parseInt(ordinalOnly[1], 10);
    if (day >= 1 && day <= 31) {
      const useNextMonth = day < todayDay;
      const month = useNextMonth ? (currentMonth % 12) + 1 : currentMonth;
      const year =
        useNextMonth && currentMonth === 12 ? currentYear + 1 : currentYear;
      const ymd = ymdIfValidCalendar(year, month, day);
      if (ymd) return ymd;
    }
  }

  return null;
};

const parseBoolean = (value) => {
  if (typeof value === "boolean") return value;
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  return null;
};

const toPositiveInteger = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.trunc(numeric);
  return rounded > 0 ? rounded : null;
};

const normalizeEmail = (value) => {
  const email = String(value || "")
    .trim()
    .toLowerCase();
  if (!email) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
};

const parseAmountToCents = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value)) return Math.round(value);
    return Math.round(value * 100);
  }

  const raw = String(value).trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d,.\-]/g, "");
  if (!cleaned) return null;

  if (/[.,]\d{1,2}$/.test(cleaned)) {
    const normalized = cleaned.replace(/,/g, ".");
    const numeric = Number.parseFloat(normalized);
    if (!Number.isFinite(numeric)) return null;
    return Math.round(numeric * 100);
  }

  const numeric = Number(cleaned.replace(/[.,]/g, ""));
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric);
};

const normalizeDeliveryChannel = (value, allowedDeliveryChannels = []) => {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (!raw) return null;
  if (!DELIVERY_CHANNEL_VALUES.has(raw)) return null;
  if (
    Array.isArray(allowedDeliveryChannels) &&
    allowedDeliveryChannels.length > 0 &&
    !allowedDeliveryChannels.includes(raw)
  ) {
    return null;
  }
  return raw;
};

const normalizeDisputeReason = (value) => {
  const raw = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
  if (DISPUTE_REASON_VALUES.has(raw)) return raw;

  const normalizedLower = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
  if (!normalizedLower) return null;

  for (const [reason, aliases] of Object.entries(DISPUTE_REASON_ALIASES)) {
    if (aliases.has(normalizedLower)) return reason;
  }

  return null;
};

const extractEmailFromText = (text) => {
  const match = String(text || "").match(
    /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i,
  );
  return match ? normalizeEmail(match[0]) : null;
};

const extractAmountCentsFromText = ({ text, currentState }) => {
  if (
    ![
      CALL_STATES.CAPTURE_UPFRONT,
      CALL_STATES.CONFIRM_AGREEMENT,
      CALL_STATES.PLAN_SELECTION,
    ].includes(currentState)
  ) {
    return null;
  }

  const normalized = String(text || "").toLowerCase();
  if (!normalized) return null;

  const amountMatch = normalized.match(
    /(\$?\s*\d{1,3}(?:[,\.\s]\d{3})*(?:[.,]\d{1,2})?|\$?\s*\d+(?:[.,]\d{1,2})?)/,
  );
  if (!amountMatch) return null;

  const candidate = amountMatch[1].replace(/\s/g, "");
  const parsed = parseAmountToCents(candidate);
  if (!parsed || parsed <= 0) return null;

  if (normalized.includes("cent")) return parsed;
  if (candidate.includes(".") || candidate.includes(",")) return parsed;
  if (parsed < 10000) return parsed * 100;
  return parsed;
};

const extractInstallmentsCountFromText = (text) => {
  const normalized = String(text || "").toLowerCase();
  if (!normalized) return null;

  const direct = normalized.match(/(\d+)\s*(installments?|cuotas?)/i);
  if (direct?.[1]) return toPositiveInteger(direct[1]);

  if (normalized.includes("four installments")) return 4;
  if (normalized.includes("three installments")) return 3;
  if (normalized.includes("two installments")) return 2;
  if (normalized.includes("one installment")) return 1;

  return null;
};

const extractIdentityVerifiedFromText = ({ text, currentState }) => {
  if (currentState !== CALL_STATES.VERIFY_IDENTITY) return null;

  const normalized = String(text || "").toLowerCase();
  if (!normalized) return null;

  const negative =
    /\b(no|nope|negative)\b/.test(normalized) ||
    /\b(not me|wrong person|not the person|no soy)\b/.test(normalized);
  const affirmative =
    /\b(yes|yeah|yep|correct|right|affirmative|si|s[ií])\b/.test(normalized) ||
    /\b(i am|im|it's me|it is me|this is|speaking)\b/.test(normalized);

  if (negative && !affirmative) return false;
  if (affirmative && !negative) return true;
  return null;
};

const extractPlanTypeFromText = ({ text, allowedPlanTypes = [] }) => {
  const normalized = String(text || "").toLowerCase();
  if (!normalized) return null;

  const hasHalf = /\bhalf\b|\b50\s*%\b|\b50\/50\b/.test(normalized);
  const hasFull =
    /\bfull\b|\bpay in full\b|\bone payment\b|\ball at once\b|\bcomplete payment\b/.test(
      normalized,
    );
  const hasInstallments =
    /\binstallments?\b|\bpayment plan\b|\bmonthly\b|\bcuotas?\b/.test(
      normalized,
    );

  const rankedCandidates = [];
  if (hasHalf) rankedCandidates.push("HALF");
  if (hasFull) rankedCandidates.push("FULL");
  if (hasInstallments) rankedCandidates.push("INSTALLMENTS_4");

  for (const candidate of rankedCandidates) {
    if (
      !Array.isArray(allowedPlanTypes) ||
      allowedPlanTypes.length === 0 ||
      allowedPlanTypes.includes(candidate)
    ) {
      return candidate;
    }
  }

  return null;
};

const extractDeliveryChannelFromText = ({
  text,
  allowedDeliveryChannels = [],
}) => {
  const normalized = String(text || "").toLowerCase();
  if (!normalized) return null;

  const asksEmail = /\be-?mail\b|\bcorreo\b|\bmail\b/.test(normalized);
  const asksSms =
    /\bsms\b|\btext\b|\btext message\b|\bmessage\b|\bmensaje\b/.test(
      normalized,
    );
  const asksBoth = /\bboth\b|\ball\b|\beither\b|\bany\b/.test(normalized);

  if (asksBoth || (asksEmail && asksSms)) {
    const channel =
      normalizeDeliveryChannel("both", allowedDeliveryChannels) ||
      normalizeDeliveryChannel("email", allowedDeliveryChannels) ||
      normalizeDeliveryChannel("sms", allowedDeliveryChannels);
    if (channel) return channel;
  }

  if (asksEmail) {
    const channel = normalizeDeliveryChannel("email", allowedDeliveryChannels);
    if (channel) return channel;
  }

  if (asksSms) {
    const channel = normalizeDeliveryChannel("sms", allowedDeliveryChannels);
    if (channel) return channel;
  }

  return null;
};

const mergeEntitySources = (entities = {}) => {
  const rawEntities = entities && typeof entities === "object" ? entities : {};
  const nestedSlots =
    rawEntities?.slots && typeof rawEntities.slots === "object"
      ? rawEntities.slots
      : {};
  return {
    ...rawEntities,
    ...nestedSlots,
  };
};

export const extractSlotPatch = ({
  entities = {},
  utterance,
  currentState,
  allowedPlanTypes = [],
  allowedDeliveryChannels = [],
}) => {
  const source = mergeEntitySources(entities);
  const normalizedUtterance = normalizeText(utterance);
  const patch = {};

  const planType =
    normalizePlanCode(source.plan_type ?? source.planType) ||
    extractPlanTypeFromText({
      text: normalizedUtterance,
      allowedPlanTypes,
    });
  if (
    planType &&
    (allowedPlanTypes.length === 0 || allowedPlanTypes.includes(planType))
  ) {
    patch.plan_type = planType;
  }

  const deliveryChannel =
    normalizeDeliveryChannel(
      source.delivery_channel ?? source.deliveryChannel ?? source.channel,
      allowedDeliveryChannels,
    ) ||
    extractDeliveryChannelFromText({
      text: normalizedUtterance,
      allowedDeliveryChannels,
    });
  if (deliveryChannel) patch.delivery_channel = deliveryChannel;

  const deliveryEmailFromSource = normalizeEmail(
    source.delivery_email ?? source.deliveryEmail ?? source.email,
  );
  if (deliveryEmailFromSource) {
    patch.delivery_email = deliveryEmailFromSource;
  } else {
    const deliveryEmailFromText = extractEmailFromText(normalizedUtterance);
    if (deliveryEmailFromText) patch.delivery_email = deliveryEmailFromText;
  }

  const upfrontAmount = parseAmountToCents(
    source.upfront_amount_cents ??
      source.upfrontAmountCents ??
      source.upfront_amount,
  );
  if (upfrontAmount && upfrontAmount > 0) {
    patch.upfront_amount_cents = upfrontAmount;
  } else {
    const amountFromText = extractAmountCentsFromText({
      text: normalizedUtterance,
      currentState,
    });
    if (amountFromText && amountFromText > 0) {
      patch.upfront_amount_cents = amountFromText;
    }
  }

  const installmentsCount = toPositiveInteger(
    source.installments_count ?? source.installmentsCount,
  );
  if (installmentsCount) {
    patch.installments_count = installmentsCount;
  } else {
    const installmentsFromText =
      extractInstallmentsCountFromText(normalizedUtterance);
    if (installmentsFromText) patch.installments_count = installmentsFromText;
  }

  const disputeReason = normalizeDisputeReason(
    source.dispute_reason ?? source.disputeReason ?? source.reason,
  );
  if (disputeReason) patch.dispute_reason = disputeReason;

  const identityVerified = parseBoolean(
    source.identity_verified ?? source.identityVerified ?? source.is_identity_verified,
  );
  if (identityVerified !== null) {
    patch.identity_verified = identityVerified;
  } else {
    const identityFromText = extractIdentityVerifiedFromText({
      text: normalizedUtterance,
      currentState,
    });
    if (identityFromText !== null) patch.identity_verified = identityFromText;
  }

  const disputeDetected = parseBoolean(
    source.dispute_detected ?? source.disputeDetected ?? source.is_dispute,
  );
  if (disputeDetected !== null) patch.dispute_detected = disputeDetected;

  const callbackRequested = parseBoolean(
    source.callback_requested ?? source.callbackRequested,
  );
  if (callbackRequested !== null) patch.callback_requested = callbackRequested;

  const goodbye = parseBoolean(
    source.goodbye ?? source.end_call ?? source.endCall,
  );
  if (goodbye !== null) patch.goodbye = goodbye;

  const agreementConfirmed = parseBoolean(
    source.agreement_confirmed ??
      source.agreementConfirmed ??
      source.confirmation,
  );
  if (agreementConfirmed !== null)
    patch.agreement_confirmed = agreementConfirmed;

  const firstDueFromSource = normalizeYmd(
    source.first_due_date ??
      source.firstDueDate ??
      source.first_payment_date ??
      source.promise_date,
  );
  let firstDue = firstDueFromSource;
  if (
    !firstDue &&
    [
      CALL_STATES.CAPTURE_FIRST_PAYMENT_DATE,
      CALL_STATES.CONFIRM_AGREEMENT,
    ].includes(currentState)
  ) {
    firstDue = extractFirstDueDateFromText(normalizedUtterance);
  }
  if (firstDue) patch.first_due_date = firstDue;

  return patch;
};
