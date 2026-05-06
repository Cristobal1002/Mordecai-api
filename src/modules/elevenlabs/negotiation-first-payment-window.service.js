/**
 * Single source for first-payment date window (policy + calendar caps).
 * Used by Eleven tool validation and by the call FSM prompts/validation.
 */

export const NEGOTIATION_CALENDAR_TZ =
  process.env.AGREEMENT_INSTALLMENT_CALENDAR_TZ || "America/Bogota";

export const toNegotiationDateOnly = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
};

export const compareIsoYmd = (a, b) => {
  if (!a || !b) return 0;
  return a < b ? -1 : a > b ? 1 : 0;
};

const getTodayYmdInTimeZone = (timeZone) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());

const addCalendarDaysToYmd = (ymd, daysToAdd) => {
  const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
  const next = new Date(Date.UTC(y, m - 1, d + daysToAdd));
  return next.toISOString().slice(0, 10);
};

const WEEKEND_SHORT_EN_US = new Set(["Sat", "Sun"]);

export const isTruthyNegotiationFlag = (value) =>
  value === true ||
  value === 1 ||
  value === "1" ||
  String(value || "").toLowerCase() === "true";

/** Last calendar day of the month containing todayYmd (YYYY-MM-DD) in negotiation TZ month index. */
export const getLastCalendarDayOfMonthYmd = (todayYmd, timeZone) => {
  const parts = todayYmd.split("-").map((x) => parseInt(x, 10));
  const y = parts[0];
  const mo = parts[1];
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) {
    return null;
  }
  const lastD = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const mm = String(mo).padStart(2, "0");
  const dd = String(lastD).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
};

const getLastWeekdayOfMonthYmd = (todayYmd, timeZone) => {
  const parts = todayYmd.split("-").map((x) => parseInt(x, 10));
  const y = parts[0];
  const mo = parts[1];
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) {
    return null;
  }
  const lastCalDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  for (let d = lastCalDay; d >= 1; d -= 1) {
    const ms = Date.UTC(y, mo - 1, d, 12, 0, 0);
    const wdShort = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
    }).format(new Date(ms));
    if (!WEEKEND_SHORT_EN_US.has(wdShort)) {
      const mm = String(mo).padStart(2, "0");
      const dd = String(d).padStart(2, "0");
      return `${y}-${mm}-${dd}`;
    }
  }
  return null;
};

/**
 * Earliest allowed first payment date = today (calendar in TZ).
 * Latest = min(relative cap, absolute deadline, end of current calendar month, optional last Mon–Fri of month).
 */
export const computeFirstPaymentWindowFromPolicyRules = (
  policyRules = {},
  timeZone,
) => {
  const today = getTodayYmdInTimeZone(timeZone);
  const maxDaysRaw =
    policyRules.negotiation_first_payment_max_days ??
    policyRules.negotiationFirstPaymentMaxDays;
  const deadlineRaw =
    policyRules.negotiation_first_payment_deadline ??
    policyRules.negotiationFirstPaymentDeadline;
  const capLastWeekdayRaw =
    policyRules.negotiation_first_payment_cap_last_weekday_of_month ??
    policyRules.negotiationFirstPaymentCapLastWeekdayOfMonth;

  const maxDays = Number(maxDaysRaw);
  let fromDays = null;
  if (Number.isFinite(maxDays) && maxDays >= 0) {
    fromDays = addCalendarDaysToYmd(today, maxDays);
  }

  const deadline = deadlineRaw ? toNegotiationDateOnly(deadlineRaw) : null;
  const endOfMonthYmd = getLastCalendarDayOfMonthYmd(today, timeZone);
  const caps = [fromDays, deadline, endOfMonthYmd].filter(Boolean);
  let maxDate =
    caps.length === 0
      ? null
      : caps.reduce((earliest, y) =>
          compareIsoYmd(y, earliest) < 0 ? y : earliest,
        );

  let lastWeekdayCapYmd = null;
  if (isTruthyNegotiationFlag(capLastWeekdayRaw)) {
    const lastWd = getLastWeekdayOfMonthYmd(today, timeZone);
    lastWeekdayCapYmd = lastWd;
    if (lastWd) {
      maxDate =
        maxDate == null || compareIsoYmd(lastWd, maxDate) < 0
          ? lastWd
          : maxDate;
    }
  }

  return {
    minDate: today,
    maxDate,
    timeZone,
    lastWeekdayCapYmd,
    endOfMonthYmd: endOfMonthYmd || null,
  };
};

export const validateFirstDueAgainstWindow = (ymd, window) => {
  if (!window || !ymd || typeof ymd !== "string") {
    return { ok: false, reason: "invalid_format" };
  }
  const s = ymd.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return { ok: false, reason: "invalid_format" };
  }
  if (Number.isNaN(Date.parse(`${s}T12:00:00Z`))) {
    return { ok: false, reason: "invalid_format" };
  }
  if (compareIsoYmd(s, window.minDate) < 0) {
    return { ok: false, reason: "too_early" };
  }
  if (window.maxDate && compareIsoYmd(s, window.maxDate) > 0) {
    return { ok: false, reason: "too_late" };
  }
  return { ok: true, ymd: s };
};

/**
 * Strips or normalizes first_due_date on slots when invalid for the window.
 * @returns {{ slots: object, rejected: boolean, reason: string | null }}
 */
export const sanitizeFirstDueDateSlot = (slots = {}, window) => {
  const raw = slots?.first_due_date ?? slots?.firstDueDate;
  if (raw == null || raw === "") {
    return { slots, rejected: false, reason: null };
  }
  const ymd = String(raw).trim().slice(0, 10);
  const v = validateFirstDueAgainstWindow(ymd, window);
  if (v.ok) {
    return {
      slots: { ...slots, first_due_date: v.ymd },
      rejected: false,
      reason: null,
    };
  }
  return {
    slots: { ...slots, first_due_date: null },
    rejected: true,
    reason: v.reason || "invalid_format",
  };
};
