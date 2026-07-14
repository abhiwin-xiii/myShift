/* MyShift — local-first shift scheduling & pay tracking app */
(function () {
  "use strict";

  const STORAGE_KEY = "myshift.data.v1";

  const DEFAULT_DATA = {
    settings: {
      currency: "€",
      defaultRate: 20,
      minGapHours: 4,
      daysOff: []
    },
    employers: [],
    sites: [],
    shifts: [],
    openShifts: []
  };

  function cloneDefault() {
    return JSON.parse(JSON.stringify(DEFAULT_DATA));
  }

  // Upgrades older data shapes:
  //  - v1/v2/v3 stored employer info directly on a flat "sites" array (no employers table).
  //    Each such entry becomes a new Employer, and the original entry becomes its first Site
  //    (keeping the same id, so existing shifts referencing it keep working).
  function migrate(obj) {
    const employers = Array.isArray(obj.employers) ? obj.employers.slice() : [];
    let sites = Array.isArray(obj.sites) ? obj.sites.slice() : [];
    const needsMigration = sites.some((s) => !s.employerId);
    if (!needsMigration) return obj;

    sites = sites.map((s) => {
      if (s.employerId) return s;
      const employerId = uid();
      employers.push({
        id: employerId,
        name: s.name || "Employer",
        contact: s.contact || "",
        rate: s.rate != null ? s.rate : null,
        notes: s.notes || ""
      });
      return {
        id: s.id,
        employerId,
        name: "Main",
        address: s.address || "",
        navLink: s.navLink || "",
        rate: s.rate != null ? s.rate : null,
        notes: ""
      };
    });

    const migrated = { ...obj, employers, sites };
    // Persist immediately so re-running the migration on every load doesn't
    // keep generating fresh random employer ids for the same data.
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated)); } catch (e) { /* ignore */ }
    return migrated;
  }

  // ---------- Cloud (Supabase) ----------
  // Cloud sync is optional: if config.js hasn't been filled in yet, the app runs
  // exactly as before (localStorage-only, no login). Once a Supabase URL + anon
  // key are set, the auth screen gates the app and data is stored server-side.
  const CLOUD_ENABLED = !!(window.MYSHIFT_SUPABASE_URL && window.MYSHIFT_SUPABASE_ANON_KEY && window.supabase);
  const sb = CLOUD_ENABLED ? window.supabase.createClient(window.MYSHIFT_SUPABASE_URL, window.MYSHIFT_SUPABASE_ANON_KEY) : null;
  let currentUserId = null;
  let pendingSync = false;

  let data = cloneDefault();

  // ---------- Persistence ----------
  // Local cache load (used directly when cloud sync isn't configured, and as an
  // offline fallback if a cloud read/write fails while signed in).
  function loadData() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return cloneDefault();
      const parsed = JSON.parse(raw);
      return migrate({
        settings: { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) },
        employers: parsed.employers || [],
        sites: parsed.sites || [],
        shifts: parsed.shifts || [],
        openShifts: parsed.openShifts || []
      });
    } catch (e) {
      console.error("Failed to load data, starting fresh.", e);
      return cloneDefault();
    }
  }

  // Always cache locally so the app opens instantly and still works offline.
  // When cloud sync is configured and signed in, also upsert to Supabase; if that
  // fails (offline, etc.) flag it so the 'online' listener below retries it.
  function saveData() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    if (!CLOUD_ENABLED || !currentUserId) return;
    sb.from("app_data").upsert({ user_id: currentUserId, data }).then(({ error }) => {
      pendingSync = !!error;
      if (error) console.warn("Cloud save failed, will retry when back online.", error);
    });
  }

  window.addEventListener("online", () => {
    if (pendingSync && CLOUD_ENABLED && currentUserId) saveData();
  });

  // Pulls the signed-in user's row from Supabase into `data`. Creates the row
  // (with default data) the first time a brand-new account signs in.
  async function cloudLoadData() {
    try {
      const { data: row, error } = await sb.from("app_data").select("data").eq("user_id", currentUserId).maybeSingle();
      if (error) throw error;
      if (row && row.data && Object.keys(row.data).length) {
        data = migrate({
          settings: { ...DEFAULT_DATA.settings, ...(row.data.settings || {}) },
          employers: row.data.employers || [],
          sites: row.data.sites || [],
          shifts: row.data.shifts || [],
          openShifts: row.data.openShifts || []
        });
      } else {
        data = cloneDefault();
        await sb.from("app_data").upsert({ user_id: currentUserId, data });
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn("Cloud load failed, using last locally cached copy.", e);
      data = loadData();
      toast("Offline — showing your last synced data");
    }
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------- Helpers ----------
  function fmtMoney(n) {
    const s = data.settings.currency || "€";
    return s + (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2);
  }

  function fmtHours(h) {
    return (Math.round(h * 100) / 100) + " hrs";
  }

  function isoDate(d) {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function todayStr() {
    return isoDate(new Date());
  }

  function dateLabel(dateStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((dt - today) / 86400000);
    const opts = { weekday: "short", month: "short", day: "numeric" };
    const label = dt.toLocaleDateString(undefined, opts);
    if (diffDays === 0) return "Today · " + label;
    if (diffDays === 1) return "Tomorrow · " + label;
    if (diffDays === -1) return "Yesterday · " + label;
    if (diffDays > 1 && diffDays <= 7) return `In ${diffDays} days · ${label}`;
    return label;
  }

  function employerById(id) {
    return data.employers.find((e) => e.id === id);
  }

  function siteById(id) {
    return data.sites.find((s) => s.id === id);
  }

  function sitesForEmployer(employerId) {
    return data.sites.filter((s) => s.employerId === employerId);
  }

  // "Employer — Site" label used everywhere a shift/site needs to be displayed.
  function siteLabel(siteId) {
    const site = siteById(siteId);
    if (!site) return "Unknown employer";
    const employer = employerById(site.employerId);
    return employer ? `${employer.name} — ${site.name}` : site.name;
  }

  // Returns {start, end} as real Date objects. End = start + duration
  // (naturally handles shifts that run past midnight since we add a duration, not a clock time).
  // Once actual hours worked are filled in, those are used instead of the expected
  // hours — so a shift that ran long correctly shows its real, longer end time.
  function shiftInterval(shift) {
    const [y, m, d] = shift.date.split("-").map(Number);
    const [sh, sm] = shift.start.split(":").map(Number);
    const start = new Date(y, m - 1, d, sh, sm);
    const hasActual = shift.actualHours !== undefined && shift.actualHours !== null && shift.actualHours !== "";
    const hrs = Number(hasActual ? shift.actualHours : shift.expectedHours) || 0;
    const end = new Date(start.getTime() + hrs * 3600000);
    return { start, end };
  }

  function isDayOff(dateStr) {
    return (data.settings.daysOff || []).includes(dateStr);
  }

  // Calendar day color: Red (day off) > Green (committed shift) > Orange (open-shift
  // candidate pending a decision) > null/white (free). Red wins even if a shift is
  // also on that date, since it's the clearest signal something needs attention.
  function dayStatus(dateStr) {
    if (isDayOff(dateStr)) return "red";
    if (data.shifts.some((s) => s.date === dateStr)) return "green";
    if (data.openShifts.some((s) => s.date === dateStr)) return "orange";
    return null;
  }

  // Evaluate a candidate ("open") shift against the committed schedule.
  // Returns { status: 'green'|'amber'|'red', reasons: string[] }
  function evaluateCandidate(cand) {
    const reasons = [];
    let status = "green";
    const { start: cStart, end: cEnd } = shiftInterval(cand);
    const gapMs = (Number(data.settings.minGapHours) || 4) * 3600000;

    data.shifts.forEach((s) => {
      const { start: sStart, end: sEnd } = shiftInterval(s);
      if (cStart < sEnd && sStart < cEnd) {
        status = "red";
        reasons.push(`Overlaps your shift at ${siteLabel(s.siteId)} on ${dateLabel(s.date)} (${s.start}, ${fmtHours(Number(s.expectedHours) || 0)})`);
      }
    });

    if (status !== "red") {
      data.shifts.forEach((s) => {
        const { start: sStart, end: sEnd } = shiftInterval(s);
        let gap = null;
        if (sEnd <= cStart) gap = cStart - sEnd;
        else if (cEnd <= sStart) gap = sStart - cEnd;
        if (gap !== null && gap < gapMs) {
          status = "amber";
          const hrs = Math.round((gap / 3600000) * 10) / 10;
          reasons.push(`Only ${hrs} hr gap from your shift at ${siteLabel(s.siteId)} on ${dateLabel(s.date)}`);
        }
      });
    }

    if (isDayOff(cand.date)) {
      if (status === "green") status = "amber";
      reasons.push("Falls on a day you marked as unavailable");
    }

    if (reasons.length === 0) reasons.push("No conflicts with your schedule.");
    return { status, reasons };
  }

  // Two committed shifts can never occupy the same time — you can't be in two
  // places at once. Used to hard-block saving a shift (direct add/edit) that
  // would overlap another one already on your schedule. excludeId lets an
  // existing shift being edited skip comparing against itself.
  function findOverlappingShift(cand, excludeId) {
    if (!cand.date || !cand.start) return null;
    const { start: cStart, end: cEnd } = shiftInterval(cand);
    return data.shifts.find((s) => {
      if (excludeId && s.id === excludeId) return false;
      const { start: sStart, end: sEnd } = shiftInterval(s);
      return cStart < sEnd && sStart < cEnd;
    }) || null;
  }

  // Sum of pay for *not-yet-paid* shifts whose expected pay date falls within
  // the current Mon–Sun week. This is deliberately separate from earnings, since
  // money credited this week can be for work done in a different week. Once a
  // shift is marked paid it moves out of "expected" and into "credited" instead.
  function computeCreditedThisWeek() {
    const weekStart = startOfWeek(new Date());
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7); // exclusive upper bound
    let total = 0, count = 0;
    data.shifts.forEach((s) => {
      if (!s.payDate || s.paid) return;
      const [y, m, d] = s.payDate.split("-").map(Number);
      const pd = new Date(y, m - 1, d);
      if (pd >= weekStart && pd < weekEnd) {
        total += calcPay(s).pay;
        count += 1;
      }
    });
    return { total, count };
  }

  // Groups not-yet-paid shifts by their expected pay date so the Payments tab
  // can show what's coming up beyond just this week.
  function computeUpcomingPayDates(limit) {
    const groups = {};
    data.shifts.forEach((s) => {
      if (!s.payDate || s.paid) return;
      if (!groups[s.payDate]) groups[s.payDate] = { date: s.payDate, total: 0, count: 0 };
      groups[s.payDate].total += calcPay(s).pay;
      groups[s.payDate].count += 1;
    });
    const today = todayStr();
    return Object.values(groups)
      .filter((g) => g.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, limit || 5);
  }

  // Pay = hours × rate (no overtime). Uses actual hours worked once filled in,
  // otherwise falls back to the expected hours for the shift. Rate resolves
  // per-shift override → site override → employer default → app default rate.
  function calcPay(shift) {
    const site = siteById(shift.siteId);
    const employer = site ? employerById(site.employerId) : null;
    const rate = (shift.rate !== undefined && shift.rate !== null && shift.rate !== "")
      ? Number(shift.rate)
      : (site && site.rate != null) ? Number(site.rate)
      : (employer && employer.rate != null) ? Number(employer.rate)
      : Number(data.settings.defaultRate);
    const hours = (shift.actualHours !== undefined && shift.actualHours !== null && shift.actualHours !== "")
      ? Number(shift.actualHours)
      : Number(shift.expectedHours) || 0;

    return { hours, rate, pay: hours * rate, breakdown: `${fmtHours(hours)} × ${fmtMoney(rate)}` };
  }

  function isPast(shift) {
    return shiftInterval(shift).end < new Date();
  }

  // Payment status lifecycle: scheduled (not worked yet) → pending (worked, unpaid)
  // → paid (money received). "paid" is the only manually-set part; the rest is derived.
  function shiftStatus(shift) {
    if (shift.paid) return "paid";
    if (isPast(shift)) return "pending";
    return "scheduled";
  }

  function statusBadgeHtml(shift) {
    const status = shiftStatus(shift);
    const map = { scheduled: ["Scheduled", "scheduled"], pending: ["Pending", "amber"], paid: ["Paid", "green"] };
    const [label, cls] = map[status];
    return `<span class="status-badge status-${cls}">${label}</span>`;
  }

  function startOfWeek(d) {
    const dt = new Date(d);
    const day = dt.getDay(); // 0 Sun
    const diff = (day === 0 ? -6 : 1) - day; // Monday start
    dt.setDate(dt.getDate() + diff);
    dt.setHours(0, 0, 0, 0);
    return dt;
  }

  function monthBounds(d) {
    const start = new Date(d.getFullYear(), d.getMonth(), 1);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1); // exclusive
    return { start, end };
  }

  // "YYYY-MM" grouping key for a shift's date, and a human label for that key.
  function monthKey(dateStr) {
    return dateStr.slice(0, 7);
  }

  function monthLabelFromKey(key) {
    const [y, m] = key.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }

  // Stacks an already-sorted list of shifts into month sections (most recent
  // month first), each with a header showing that month's shift count and total
  // pay, then hands the shifts for that month to appendFn to render the cards.
  function renderGroupedByMonth(container, shifts, appendFn) {
    const groups = {};
    shifts.forEach((s) => {
      const key = monthKey(s.date);
      (groups[key] = groups[key] || []).push(s);
    });
    Object.keys(groups).sort((a, b) => b.localeCompare(a)).forEach((key) => {
      const monthShifts = groups[key];
      let total = 0;
      monthShifts.forEach((s) => { total += calcPay(s).pay; });
      const header = document.createElement("div");
      header.className = "month-group-header";
      header.innerHTML = `<span>${monthLabelFromKey(key)}</span><span class="month-group-total">${fmtMoney(total)} · ${monthShifts.length} shift${monthShifts.length === 1 ? "" : "s"}</span>`;
      container.appendChild(header);
      const listWrap = document.createElement("div");
      listWrap.className = "card-list month-group-list";
      container.appendChild(listWrap);
      appendFn(listWrap, monthShifts);
    });
  }

  // Total projected pay for every shift dated this month, regardless of status —
  // "if everything scheduled happens, this is what the month adds up to."
  function computeExpectedThisMonth() {
    const { start, end } = monthBounds(new Date());
    let total = 0, count = 0;
    data.shifts.forEach((s) => {
      const [y, m, d] = s.date.split("-").map(Number);
      const dt = new Date(y, m - 1, d);
      if (dt >= start && dt < end) {
        total += calcPay(s).pay;
        count += 1;
      }
    });
    return { total, count };
  }

  // Money actually marked "paid" whose pay date falls in the current month.
  function computeCreditedThisMonth() {
    const { start, end } = monthBounds(new Date());
    let total = 0, count = 0;
    data.shifts.forEach((s) => {
      if (!s.paid || !s.payDate) return;
      const [y, m, d] = s.payDate.split("-").map(Number);
      const pd = new Date(y, m - 1, d);
      if (pd >= start && pd < end) {
        total += calcPay(s).pay;
        count += 1;
      }
    });
    return { total, count };
  }

  // Work that's done but not yet paid — the running total owed to you right now.
  function computePendingTotal() {
    let total = 0, count = 0;
    data.shifts.forEach((s) => {
      if (shiftStatus(s) === "pending") {
        total += calcPay(s).pay;
        count += 1;
      }
    });
    return { total, count };
  }

  // ---------- Toast ----------
  let toastTimer;
  function toast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
  }

  // ---------- Navigation ----------
  const views = ["dashboard", "shifts", "open", "calendar", "payments", "employers", "settings"];
  const titles = { dashboard: "Dashboard", shifts: "Shifts", open: "Open Shifts", calendar: "Calendar", payments: "Payments", employers: "Employers", settings: "Settings" };

  function switchView(view) {
    views.forEach((v) => {
      document.getElementById("view-" + v).classList.toggle("active", v === view);
    });
    document.querySelectorAll(".navbtn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === view);
    });
    document.getElementById("pageTitle").textContent = titles[view];
    if (view === "dashboard") renderDashboard();
    if (view === "shifts") renderShifts();
    if (view === "open") renderOpenShifts();
    if (view === "calendar") renderCalendar();
    if (view === "payments") renderPayments();
    if (view === "employers") renderEmployers();
    if (view === "settings") renderSettings();
  }

  document.querySelectorAll(".navbtn").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  // ---------- Rendering: Dashboard ----------
  function renderDashboard() {
    const now = new Date();
    const weekStart = startOfWeek(now);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    let weekEarnings = 0, weekHours = 0, monthEarnings = 0, monthHours = 0;

    data.shifts.forEach((s) => {
      if (!isPast(s)) return;
      const [y, m, d] = s.date.split("-").map(Number);
      const dt = new Date(y, m - 1, d);
      const { pay, hours } = calcPay(s);
      if (dt >= weekStart) { weekEarnings += pay; weekHours += hours; }
      if (dt >= monthStart) { monthEarnings += pay; monthHours += hours; }
    });

    document.getElementById("statWeekEarnings").textContent = fmtMoney(weekEarnings);
    document.getElementById("statWeekHours").textContent = fmtHours(weekHours);
    document.getElementById("statMonthEarnings").textContent = fmtMoney(monthEarnings);
    document.getElementById("statMonthHours").textContent = fmtHours(monthHours);

    const upcoming = data.shifts.filter((s) => !isPast(s))
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
      .slice(0, 5);
    renderShiftCards(document.getElementById("upcomingList"), upcoming, "No upcoming shifts yet.");

    renderDashboardCalendar();
  }

  // ---------- Rendering: Payments ----------
  function renderPayments() {
    const now = new Date();
    const weekStart = startOfWeek(now);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    let weekEarnings = 0, weekHours = 0, monthEarnings = 0, monthHours = 0;

    data.shifts.forEach((s) => {
      if (!isPast(s)) return;
      const [y, m, d] = s.date.split("-").map(Number);
      const dt = new Date(y, m - 1, d);
      const { pay, hours } = calcPay(s);
      if (dt >= weekStart) { weekEarnings += pay; weekHours += hours; }
      if (dt >= monthStart) { monthEarnings += pay; monthHours += hours; }
    });

    document.getElementById("statPayWeekEarnings").textContent = fmtMoney(weekEarnings);
    document.getElementById("statPayWeekHours").textContent = fmtHours(weekHours);
    document.getElementById("statPayMonthEarnings").textContent = fmtMoney(monthEarnings);
    document.getElementById("statPayMonthHours").textContent = fmtHours(monthHours);

    const expected = computeExpectedThisMonth();
    document.getElementById("statExpectedMonth").textContent = fmtMoney(expected.total);
    document.getElementById("statExpectedMonthSub").textContent = `${expected.count} shift${expected.count === 1 ? "" : "s"}`;

    const creditedMonth = computeCreditedThisMonth();
    document.getElementById("statCreditedMonth").textContent = fmtMoney(creditedMonth.total);
    document.getElementById("statCreditedMonthSub").textContent = `${creditedMonth.count} shift${creditedMonth.count === 1 ? "" : "s"}`;

    const pending = computePendingTotal();
    document.getElementById("statPending").textContent = fmtMoney(pending.total);
    document.getElementById("statPendingSub").textContent = `${pending.count} shift${pending.count === 1 ? "" : "s"}`;

    const creditedWeek = computeCreditedThisWeek();
    document.getElementById("statCreditedWeek").textContent = fmtMoney(creditedWeek.total);
    document.getElementById("statCreditedWeekSub").textContent = `${creditedWeek.count} shift${creditedWeek.count === 1 ? "" : "s"}`;

    const container = document.getElementById("paydayList");
    const upcoming = computeUpcomingPayDates(5);
    container.innerHTML = "";
    if (upcoming.length === 0) {
      container.classList.add("empty");
      container.textContent = "No upcoming pay dates yet.";
    } else {
      container.classList.remove("empty");
      upcoming.forEach((p) => {
        const card = document.createElement("div");
        card.className = "item-card";
        card.innerHTML = `
          <div class="item-main">
            <div class="item-title">${dateLabel(p.date)}</div>
            <div class="item-sub">${p.count} shift${p.count === 1 ? "" : "s"}</div>
          </div>
          <div class="item-side">
            <div class="item-amount">${fmtMoney(p.total)}</div>
          </div>`;
        container.appendChild(card);
      });
    }

    renderPaymentShiftsList(paymentFilter);
  }

  let paymentFilter = "pending";
  document.querySelectorAll("#view-payments .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("#view-payments .chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      paymentFilter = chip.dataset.payfilter;
      renderPaymentShiftsList(paymentFilter);
    });
  });

  function renderPaymentShiftsList(filter) {
    const container = document.getElementById("paymentShiftsList");
    let list = data.shifts.filter((s) => shiftStatus(s) === filter);
    list.sort((a, b) => filter === "scheduled"
      ? (a.date + a.start).localeCompare(b.date + b.start)
      : (b.date + b.start).localeCompare(a.date + a.start));
    container.innerHTML = "";
    if (list.length === 0) {
      container.classList.add("empty");
      container.textContent = `No ${filter} shifts.`;
      return;
    }
    container.classList.remove("empty");
    // Scheduled (upcoming) stays a flat, near-term list; Pending/Paid are
    // historical, so stack them month-by-month with a per-month pay total.
    if (filter === "scheduled") {
      appendPaymentShiftCards(container, list, filter);
    } else {
      renderGroupedByMonth(container, list, (c, s) => appendPaymentShiftCards(c, s, filter));
    }
  }

  function appendPaymentShiftCards(container, shifts, filter) {
    shifts.forEach((s) => {
      const { pay } = calcPay(s);
      const card = document.createElement("div");
      card.className = "item-card open-card";
      card.innerHTML = `
        <div class="item-main">
          <div class="item-title">${escapeHtml(siteLabel(s.siteId))} ${statusBadgeHtml(s)}</div>
          <div class="item-sub">${dateLabel(s.date)} · ${s.start} · ${fmtMoney(pay)}</div>
        </div>
        ${filter === "pending" ? '<div class="open-actions"><button type="button" class="accept-btn">Mark Paid</button></div>' : ""}`;
      card.querySelector(".item-main").addEventListener("click", () => openShiftModal(s.id));
      const markBtn = card.querySelector(".accept-btn");
      if (markBtn) {
        markBtn.addEventListener("click", (e) => { e.stopPropagation(); markShiftPaid(s.id); });
      }
      container.appendChild(card);
    });
  }

  function markShiftPaid(id) {
    const idx = data.shifts.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const updated = { ...data.shifts[idx], paid: true };
    if (!updated.payDate) updated.payDate = todayStr();
    data.shifts[idx] = updated;
    saveData();
    toast("Marked as paid");
    refreshCurrentView();
  }

  function renderShiftCards(container, shifts, emptyMsg) {
    container.innerHTML = "";
    if (shifts.length === 0) {
      container.classList.add("empty");
      container.textContent = emptyMsg;
      return;
    }
    container.classList.remove("empty");
    appendShiftCards(container, shifts);
  }

  function appendShiftCards(container, shifts) {
    shifts.forEach((s) => {
      const { pay } = calcPay(s);
      const onDayOff = isDayOff(s.date);
      const hasActual = s.actualHours !== undefined && s.actualHours !== null && s.actualHours !== "";
      const hoursNote = hasActual ? `${fmtHours(Number(s.actualHours))} worked` : `${fmtHours(Number(s.expectedHours) || 0)} expected`;
      const card = document.createElement("div");
      card.className = "item-card" + (onDayOff ? " status-amber" : "");
      card.innerHTML = `
        <div class="item-main">
          <div class="item-title">${escapeHtml(siteLabel(s.siteId))} ${statusBadgeHtml(s)} ${onDayOff ? '<span class="item-tag item-tag-warn">Day Off</span>' : ""}</div>
          <div class="item-sub">${dateLabel(s.date)} · ${s.start} · ${hoursNote}</div>
        </div>
        <div class="item-side">
          <div class="item-amount">${fmtMoney(pay)}</div>
        </div>`;
      card.addEventListener("click", () => openShiftModal(s.id));
      container.appendChild(card);
    });
  }

  // ---------- Rendering: Shifts ----------
  let shiftFilter = "upcoming";
  document.querySelectorAll("#view-shifts .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("#view-shifts .chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      shiftFilter = chip.dataset.filter;
      renderShifts();
    });
  });

  function renderShifts() {
    const container = document.getElementById("shiftsList");
    let list = data.shifts.slice();
    if (shiftFilter === "upcoming") list = list.filter((s) => !isPast(s));
    if (shiftFilter === "past") list = list.filter((s) => isPast(s));
    list.sort((a, b) => shiftFilter === "past"
      ? (b.date + b.start).localeCompare(a.date + a.start)
      : (a.date + a.start).localeCompare(b.date + b.start));

    container.innerHTML = "";
    if (list.length === 0) {
      container.classList.add("empty");
      container.textContent = "No shifts in this view.";
      return;
    }
    container.classList.remove("empty");
    // Past shifts are historical, so stack them month-by-month with a per-month
    // pay total; Upcoming/All stay a flat, chronological list.
    if (shiftFilter === "past") {
      renderGroupedByMonth(container, list, appendShiftCards);
    } else {
      appendShiftCards(container, list);
    }
  }

  // ---------- Rendering: Employers ----------
  function renderEmployers() {
    const container = document.getElementById("employersList");
    container.innerHTML = "";
    if (data.employers.length === 0) {
      container.classList.add("empty");
      container.textContent = "No employers yet. Tap + to add one.";
      return;
    }
    container.classList.remove("empty");
    data.employers.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((emp) => {
      const siteCount = sitesForEmployer(emp.id).length;
      const card = document.createElement("div");
      card.className = "item-card";
      card.innerHTML = `
        <div class="item-main">
          <div class="item-title">${escapeHtml(emp.name)}</div>
          <div class="item-sub">${escapeHtml(emp.contact || "No contact set")} · ${siteCount} site${siteCount === 1 ? "" : "s"}</div>
        </div>
        <div class="item-side">
          <div class="item-amount">${emp.rate != null ? fmtMoney(emp.rate) + "/hr" : "Default rate"}</div>
        </div>`;
      card.addEventListener("click", () => openEmployerModal(emp.id));
      container.appendChild(card);
    });
  }

  // ---------- Rendering: Settings ----------
  function renderSettings() {
    document.getElementById("setCurrency").value = data.settings.currency;
    document.getElementById("setDefaultRate").value = data.settings.defaultRate;
    document.getElementById("setMinGap").value = data.settings.minGapHours;
    renderDaysOffList();
  }

  document.getElementById("settingsForm").addEventListener("submit", (e) => {
    e.preventDefault();
    data.settings.currency = document.getElementById("setCurrency").value.trim() || "€";
    data.settings.defaultRate = Number(document.getElementById("setDefaultRate").value) || 0;
    data.settings.minGapHours = Number(document.getElementById("setMinGap").value) || 0;
    saveData();
    toast("Settings saved");
    renderDashboard();
  });

  // ---------- Days Off ----------
  function renderDaysOffList() {
    const container = document.getElementById("daysOffList");
    container.innerHTML = "";
    const days = (data.settings.daysOff || []).slice().sort();
    if (days.length === 0) {
      container.classList.add("empty");
      container.textContent = "No days off marked.";
      return;
    }
    container.classList.remove("empty");
    days.forEach((d) => {
      const chip = document.createElement("div");
      chip.className = "day-chip";
      chip.innerHTML = `<span>${dateLabel(d)}</span><button type="button" aria-label="Remove">&times;</button>`;
      chip.querySelector("button").addEventListener("click", () => {
        data.settings.daysOff = data.settings.daysOff.filter((x) => x !== d);
        saveData();
        renderDaysOffList();
        toast("Day off removed");
      });
      container.appendChild(chip);
    });
  }

  document.getElementById("addDayOffBtn").addEventListener("click", () => {
    const input = document.getElementById("dayOffInput");
    const val = input.value;
    if (!val) return;
    if (!data.settings.daysOff.includes(val)) {
      data.settings.daysOff.push(val);
      saveData();
      renderDaysOffList();
      toast("Day off added");
    }
    input.value = "";
  });

  document.getElementById("exportBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `myshift-backup-${todayStr()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById("importFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed.sites || !parsed.shifts) throw new Error("Invalid file");
        data = migrate({
          settings: { ...DEFAULT_DATA.settings, ...(parsed.settings || {}) },
          employers: parsed.employers || [],
          sites: parsed.sites,
          shifts: parsed.shifts,
          openShifts: parsed.openShifts || []
        });
        saveData();
        toast("Backup imported");
        switchView("dashboard");
      } catch (err) {
        alert("Could not import file: " + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  });

  // ---------- Shift Modal ----------
  const shiftModal = document.getElementById("shiftModal");
  const shiftForm = document.getElementById("shiftForm");

  function populateEmployerSelect(selectId) {
    const sel = document.getElementById(selectId);
    sel.innerHTML = "";
    if (data.employers.length === 0) {
      sel.innerHTML = '<option value="">Add an employer first</option>';
      return;
    }
    data.employers.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((emp) => {
      const opt = document.createElement("option");
      opt.value = emp.id;
      opt.textContent = emp.name;
      sel.appendChild(opt);
    });
  }

  function populateSiteSelectForEmployer(selectId, employerId) {
    const sel = document.getElementById(selectId);
    sel.innerHTML = "";
    if (!employerId) {
      sel.innerHTML = '<option value="">Choose an employer first</option>';
      return;
    }
    const sites = sitesForEmployer(employerId);
    if (sites.length === 0) {
      sel.innerHTML = '<option value="">No sites yet — add one in Employers</option>';
      return;
    }
    sites.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.name;
      sel.appendChild(opt);
    });
  }

  function openShiftModal(id, presetDate) {
    populateEmployerSelect("shiftEmployer");
    if (data.employers.length === 0) {
      toast("Add an employer first");
      openEmployerModal(null);
      return;
    }
    const isEdit = !!id;
    document.getElementById("shiftModalTitle").textContent = isEdit ? "Edit Shift" : "Add Shift";
    document.getElementById("deleteShiftBtn").hidden = !isEdit;
    if (isEdit) {
      const s = data.shifts.find((x) => x.id === id);
      const site = siteById(s.siteId);
      const employerId = site ? site.employerId : "";
      document.getElementById("shiftId").value = s.id;
      document.getElementById("shiftEmployer").value = employerId;
      populateSiteSelectForEmployer("shiftSite", employerId);
      document.getElementById("shiftSite").value = s.siteId;
      document.getElementById("shiftDate").value = s.date;
      document.getElementById("shiftStart").value = s.start;
      document.getElementById("shiftExpectedHours").value = s.expectedHours;
      document.getElementById("shiftRate").value = s.rate != null ? s.rate : "";
      document.getElementById("shiftPayDate").value = s.payDate || "";
      document.getElementById("shiftActualHours").value = s.actualHours != null ? s.actualHours : "";
      document.getElementById("shiftPaid").checked = !!s.paid;
      document.getElementById("shiftNotes").value = s.notes || "";
    } else {
      shiftForm.reset();
      document.getElementById("shiftId").value = "";
      document.getElementById("shiftPaid").checked = false;
      document.getElementById("shiftDate").value = presetDate || todayStr();
      const firstEmployer = data.employers.slice().sort((a, b) => a.name.localeCompare(b.name))[0];
      document.getElementById("shiftEmployer").value = firstEmployer.id;
      populateSiteSelectForEmployer("shiftSite", firstEmployer.id);
    }
    updatePayPreview();
    openModal("shiftModal");
  }

  document.getElementById("shiftEmployer").addEventListener("change", () => {
    populateSiteSelectForEmployer("shiftSite", document.getElementById("shiftEmployer").value);
    updatePayPreview();
  });

  function updateHoursWorkedVisibility() {
    const wrap = document.getElementById("hoursWorkedWrap");
    const paidWrap = document.getElementById("paidWrap");
    const statusRow = document.getElementById("shiftStatusRow");
    const date = document.getElementById("shiftDate").value;
    const start = document.getElementById("shiftStart").value;
    const expectedHours = document.getElementById("shiftExpectedHours").value;
    if (!date || !start || !expectedHours) {
      wrap.hidden = true;
      paidWrap.hidden = true;
      statusRow.hidden = true;
      return;
    }
    const paidChecked = document.getElementById("shiftPaid").checked;
    const past = isPast({ date, start, expectedHours });
    wrap.hidden = !past;
    paidWrap.hidden = !past;
    statusRow.hidden = false;
    const status = shiftStatus({ date, start, expectedHours, paid: paidChecked });
    const map = { scheduled: ["Scheduled", "scheduled"], pending: ["Pending", "amber"], paid: ["Paid", "green"] };
    const [label, cls] = map[status];
    statusRow.innerHTML = `Payment status: <span class="status-badge status-${cls}">${label}</span>`;
  }

  function updatePayPreview() {
    const siteId = document.getElementById("shiftSite").value;
    const date = document.getElementById("shiftDate").value;
    const start = document.getElementById("shiftStart").value;
    const expectedHours = document.getElementById("shiftExpectedHours").value;
    const el = document.getElementById("shiftPayPreview");
    updateHoursWorkedVisibility();
    if (!siteId || !start || !expectedHours) { el.textContent = "Fill in employer, site, start time, and expected hours to preview pay."; return; }
    const id = document.getElementById("shiftId").value;
    const tmp = {
      siteId, date, start,
      expectedHours,
      rate: document.getElementById("shiftRate").value,
      actualHours: document.getElementById("shiftActualHours").value
    };
    const { pay, breakdown } = calcPay(tmp);
    let html = `Estimated pay: <strong>${fmtMoney(pay)}</strong><br>${breakdown}`;
    if (date) {
      const overlap = findOverlappingShift(tmp, id || null);
      if (overlap) {
        html += `<br><span style="color:var(--danger); font-weight:700;">Overlaps your shift at ${escapeHtml(siteLabel(overlap.siteId))} on ${dateLabel(overlap.date)} (${overlap.start}). This can't be saved until resolved.</span>`;
      }
    }
    el.innerHTML = html;
  }

  ["shiftSite", "shiftDate", "shiftStart", "shiftExpectedHours", "shiftRate", "shiftActualHours", "shiftPaid"].forEach((id) => {
    document.getElementById(id).addEventListener("input", updatePayPreview);
    document.getElementById(id).addEventListener("change", updatePayPreview);
  });

  shiftForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = document.getElementById("shiftId").value;
    const actualHoursVal = document.getElementById("shiftActualHours").value;
    const rateVal = document.getElementById("shiftRate").value;
    const paidChecked = document.getElementById("shiftPaid").checked;
    let payDateVal = document.getElementById("shiftPayDate").value || null;
    if (paidChecked && !payDateVal) payDateVal = todayStr();
    const payload = {
      siteId: document.getElementById("shiftSite").value,
      date: document.getElementById("shiftDate").value,
      start: document.getElementById("shiftStart").value,
      expectedHours: Number(document.getElementById("shiftExpectedHours").value) || 0,
      rate: rateVal !== "" ? Number(rateVal) : null,
      payDate: payDateVal,
      actualHours: actualHoursVal !== "" ? Number(actualHoursVal) : null,
      paid: paidChecked,
      notes: document.getElementById("shiftNotes").value.trim()
    };
    if (!payload.siteId) {
      alert("Choose a site for this shift (add one under the employer in the Employers tab if none exist yet).");
      return;
    }
    const overlap = findOverlappingShift(payload, id || null);
    if (overlap) {
      alert(`This overlaps your shift at ${siteLabel(overlap.siteId)} on ${dateLabel(overlap.date)} (${overlap.start}). Two shifts can't cover the same time — adjust the time, or edit/delete the other shift first.`);
      return;
    }
    if (id) {
      const idx = data.shifts.findIndex((s) => s.id === id);
      data.shifts[idx] = { ...data.shifts[idx], ...payload };
    } else {
      data.shifts.push({ id: uid(), ...payload });
    }
    saveData();
    closeModal("shiftModal");
    toast("Shift saved");
    refreshCurrentView();
  });

  document.getElementById("deleteShiftBtn").addEventListener("click", () => {
    const id = document.getElementById("shiftId").value;
    if (confirm("Delete this shift?")) {
      data.shifts = data.shifts.filter((s) => s.id !== id);
      saveData();
      closeModal("shiftModal");
      toast("Shift deleted");
      refreshCurrentView();
    }
  });

  document.getElementById("fabAddShift").addEventListener("click", () => openShiftModal(null));
  document.getElementById("fabAddShift2").addEventListener("click", () => openShiftModal(null));

  // ---------- Employer Modal ----------
  const employerForm = document.getElementById("employerForm");

  function openEmployerModal(id) {
    const isEdit = !!id;
    document.getElementById("employerModalTitle").textContent = isEdit ? "Edit Employer" : "Add Employer";
    document.getElementById("deleteEmployerBtn").hidden = !isEdit;
    document.getElementById("employerSitesHeader").hidden = !isEdit;
    document.getElementById("employerSitesList").hidden = !isEdit;
    document.getElementById("addSiteBtn").hidden = !isEdit;
    if (isEdit) {
      const emp = employerById(id);
      document.getElementById("employerId").value = emp.id;
      document.getElementById("employerName").value = emp.name;
      document.getElementById("employerContact").value = emp.contact || "";
      document.getElementById("employerRate").value = emp.rate != null ? emp.rate : "";
      document.getElementById("employerNotes").value = emp.notes || "";
      renderEmployerSites(emp.id);
    } else {
      employerForm.reset();
      document.getElementById("employerId").value = "";
    }
    openModal("employerModal");
  }

  function renderEmployerSites(employerId) {
    const container = document.getElementById("employerSitesList");
    container.innerHTML = "";
    const sites = sitesForEmployer(employerId);
    if (sites.length === 0) {
      container.classList.add("empty");
      container.textContent = "No sites yet. Tap “Add Site” below.";
      return;
    }
    container.classList.remove("empty");
    sites.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((site) => {
      const card = document.createElement("div");
      card.className = "item-card";
      card.innerHTML = `
        <div class="item-main">
          <div class="item-title">${escapeHtml(site.name)}</div>
          <div class="item-sub">${escapeHtml(site.address || "No address set")}</div>
        </div>
        <div class="item-side">
          <div class="item-amount">${site.rate != null ? fmtMoney(site.rate) + "/hr" : "Employer rate"}</div>
        </div>`;
      card.addEventListener("click", () => {
        closeModal("employerModal");
        openSiteModal(site.id, employerId);
      });
      container.appendChild(card);
    });
  }

  employerForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = document.getElementById("employerId").value;
    const rateVal = document.getElementById("employerRate").value;
    const payload = {
      name: document.getElementById("employerName").value.trim(),
      contact: document.getElementById("employerContact").value.trim(),
      rate: rateVal !== "" ? Number(rateVal) : null,
      notes: document.getElementById("employerNotes").value.trim()
    };
    if (id) {
      const idx = data.employers.findIndex((e) => e.id === id);
      data.employers[idx] = { ...data.employers[idx], ...payload };
    } else {
      data.employers.push({ id: uid(), ...payload });
    }
    saveData();
    closeModal("employerModal");
    toast("Employer saved");
    refreshCurrentView();
  });

  document.getElementById("deleteEmployerBtn").addEventListener("click", () => {
    const id = document.getElementById("employerId").value;
    if (sitesForEmployer(id).length > 0) {
      alert("This employer still has sites. Delete those sites first.");
      return;
    }
    if (confirm("Delete this employer?")) {
      data.employers = data.employers.filter((e) => e.id !== id);
      saveData();
      closeModal("employerModal");
      toast("Employer deleted");
      refreshCurrentView();
    }
  });

  document.getElementById("addSiteBtn").addEventListener("click", () => {
    const employerId = document.getElementById("employerId").value;
    closeModal("employerModal");
    openSiteModal(null, employerId);
  });

  document.getElementById("fabAddEmployer").addEventListener("click", () => openEmployerModal(null));

  // ---------- Site Modal (nested under an Employer) ----------
  const siteForm = document.getElementById("siteForm");
  let siteModalReturnEmployerId = null;

  function openSiteModal(id, employerId) {
    const isEdit = !!id;
    const site = isEdit ? siteById(id) : null;
    const effectiveEmployerId = employerId || (site ? site.employerId : null);
    siteModalReturnEmployerId = effectiveEmployerId;
    document.getElementById("siteModalTitle").textContent = isEdit ? "Edit Site" : "Add Site";
    document.getElementById("deleteSiteBtn").hidden = !isEdit;
    document.getElementById("siteEmployerId").value = effectiveEmployerId || "";
    if (isEdit) {
      document.getElementById("siteId").value = site.id;
      document.getElementById("siteName").value = site.name;
      document.getElementById("siteAddress").value = site.address || "";
      document.getElementById("siteNavLink").value = site.navLink || "";
      document.getElementById("siteRate").value = site.rate != null ? site.rate : "";
      document.getElementById("siteNotes").value = site.notes || "";
    } else {
      siteForm.reset();
      document.getElementById("siteId").value = "";
      document.getElementById("siteEmployerId").value = effectiveEmployerId || "";
    }
    openModal("siteModal");
  }

  siteForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = document.getElementById("siteId").value;
    const employerId = document.getElementById("siteEmployerId").value;
    const payload = {
      employerId,
      name: document.getElementById("siteName").value.trim(),
      address: document.getElementById("siteAddress").value.trim(),
      navLink: document.getElementById("siteNavLink").value.trim(),
      rate: document.getElementById("siteRate").value ? Number(document.getElementById("siteRate").value) : null,
      notes: document.getElementById("siteNotes").value.trim()
    };
    if (id) {
      const idx = data.sites.findIndex((s) => s.id === id);
      data.sites[idx] = { ...data.sites[idx], ...payload };
    } else {
      data.sites.push({ id: uid(), ...payload });
    }
    saveData();
    closeModal("siteModal");
    toast("Site saved");
    const returnTo = siteModalReturnEmployerId;
    siteModalReturnEmployerId = null;
    if (returnTo && document.getElementById("view-employers").classList.contains("active")) {
      openEmployerModal(returnTo);
    } else {
      refreshCurrentView();
    }
  });

  document.getElementById("deleteSiteBtn").addEventListener("click", () => {
    const id = document.getElementById("siteId").value;
    const inUse = data.shifts.some((s) => s.siteId === id) || data.openShifts.some((s) => s.siteId === id);
    if (inUse) {
      alert("This site has shifts logged against it. Delete those shifts first.");
      return;
    }
    if (confirm("Delete this site?")) {
      data.sites = data.sites.filter((s) => s.id !== id);
      saveData();
      closeModal("siteModal");
      toast("Site deleted");
      const returnTo = siteModalReturnEmployerId;
      siteModalReturnEmployerId = null;
      if (returnTo && document.getElementById("view-employers").classList.contains("active")) {
        openEmployerModal(returnTo);
      } else {
        refreshCurrentView();
      }
    }
  });

  // ---------- Rendering: Open Shifts ----------
  function renderOpenShifts() {
    const container = document.getElementById("openList");
    container.innerHTML = "";
    if (data.openShifts.length === 0) {
      container.classList.add("empty");
      container.textContent = "No open shifts added yet. Tap + to check one.";
      return;
    }
    container.classList.remove("empty");
    const statusLabel = { green: "Clear", amber: "Caution", red: "Conflict" };
    data.openShifts.slice()
      .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start))
      .forEach((cand) => {
        const { pay } = calcPay(cand);
        const { status, reasons } = evaluateCandidate(cand);
        const card = document.createElement("div");
        card.className = `item-card open-card status-${status}`;
        card.innerHTML = `
          <div class="item-main">
            <div class="item-title">${escapeHtml(siteLabel(cand.siteId))} <span class="status-badge status-${status}">${statusLabel[status]}</span></div>
            <div class="item-sub">${dateLabel(cand.date)} · ${cand.start} · ${fmtHours(Number(cand.expectedHours) || 0)} · ${fmtMoney(pay)}</div>
            <div class="reason-text status-${status}-text">${reasons.map(escapeHtml).join(" · ")}</div>
          </div>
          <div class="open-actions">
            <button type="button" class="accept-btn">Accept</button>
            <button type="button" class="dismiss-btn">Dismiss</button>
          </div>`;
        card.querySelector(".accept-btn").addEventListener("click", (e) => { e.stopPropagation(); acceptOpenShift(cand.id); });
        card.querySelector(".dismiss-btn").addEventListener("click", (e) => { e.stopPropagation(); dismissOpenShift(cand.id); });
        card.querySelector(".item-main").addEventListener("click", () => openOpenModal(cand.id));
        container.appendChild(card);
      });
  }

  function acceptOpenShift(id) {
    const cand = data.openShifts.find((c) => c.id === id);
    if (!cand) return;
    const { status, reasons } = evaluateCandidate(cand);
    if (status === "red") {
      alert("This overlaps a shift you already have — two shifts can't cover the same time. " + reasons.join(" "));
      return;
    } else if (status === "amber") {
      if (!confirm("This has a tight turnaround or falls on a day off. Add it anyway?")) return;
    }
    data.shifts.push({
      id: uid(),
      siteId: cand.siteId,
      date: cand.date,
      start: cand.start,
      expectedHours: Number(cand.expectedHours) || 0,
      rate: cand.rate != null ? cand.rate : null,
      payDate: cand.payDate || null,
      actualHours: null,
      paid: false,
      notes: cand.notes || ""
    });
    data.openShifts = data.openShifts.filter((c) => c.id !== id);
    saveData();
    toast("Added to your shifts");
    refreshCurrentView();
  }

  function dismissOpenShift(id) {
    data.openShifts = data.openShifts.filter((c) => c.id !== id);
    saveData();
    toast("Removed");
    refreshCurrentView();
  }

  // ---------- Open Shift Modal ----------
  const openForm = document.getElementById("openForm");

  function openOpenModal(id) {
    populateEmployerSelect("openEmployer");
    if (data.employers.length === 0) {
      toast("Add an employer first");
      openEmployerModal(null);
      return;
    }
    const isEdit = !!id;
    document.getElementById("openModalTitle").textContent = isEdit ? "Edit Open Shift" : "Check Open Shift";
    document.getElementById("deleteOpenBtn").hidden = !isEdit;
    if (isEdit) {
      const c = data.openShifts.find((x) => x.id === id);
      const site = siteById(c.siteId);
      const employerId = site ? site.employerId : "";
      document.getElementById("openId").value = c.id;
      document.getElementById("openEmployer").value = employerId;
      populateSiteSelectForEmployer("openSite", employerId);
      document.getElementById("openSite").value = c.siteId;
      document.getElementById("openDate").value = c.date;
      document.getElementById("openStart").value = c.start;
      document.getElementById("openExpectedHours").value = c.expectedHours;
      document.getElementById("openRate").value = c.rate != null ? c.rate : "";
      document.getElementById("openPayDate").value = c.payDate || "";
      document.getElementById("openNotes").value = c.notes || "";
    } else {
      openForm.reset();
      document.getElementById("openId").value = "";
      document.getElementById("openDate").value = todayStr();
      const firstEmployer = data.employers.slice().sort((a, b) => a.name.localeCompare(b.name))[0];
      document.getElementById("openEmployer").value = firstEmployer.id;
      populateSiteSelectForEmployer("openSite", firstEmployer.id);
    }
    updateOpenStatusPreview();
    openModal("openModal");
  }

  document.getElementById("openEmployer").addEventListener("change", () => {
    populateSiteSelectForEmployer("openSite", document.getElementById("openEmployer").value);
    updateOpenStatusPreview();
  });

  function updateOpenStatusPreview() {
    const siteId = document.getElementById("openSite").value;
    const date = document.getElementById("openDate").value;
    const start = document.getElementById("openStart").value;
    const expectedHours = document.getElementById("openExpectedHours").value;
    const el = document.getElementById("openStatusPreview");
    if (!siteId || !date || !start || !expectedHours) { el.textContent = "Fill in the details to see conflict status."; return; }
    const cand = { siteId, date, start, expectedHours, rate: document.getElementById("openRate").value };
    const { status, reasons } = evaluateCandidate(cand);
    const { pay } = calcPay(cand);
    const statusLabel = { green: "Clear", amber: "Caution", red: "Conflict" };
    el.innerHTML = `<span class="status-badge status-${status}">${statusLabel[status]}</span> · Est. pay ${fmtMoney(pay)}<br>${reasons.map(escapeHtml).join("<br>")}`;
  }

  ["openSite", "openDate", "openStart", "openExpectedHours", "openRate"].forEach((id) => {
    document.getElementById(id).addEventListener("input", updateOpenStatusPreview);
    document.getElementById(id).addEventListener("change", updateOpenStatusPreview);
  });

  openForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const id = document.getElementById("openId").value;
    const openRateVal = document.getElementById("openRate").value;
    const payload = {
      siteId: document.getElementById("openSite").value,
      date: document.getElementById("openDate").value,
      start: document.getElementById("openStart").value,
      expectedHours: Number(document.getElementById("openExpectedHours").value) || 0,
      rate: openRateVal !== "" ? Number(openRateVal) : null,
      payDate: document.getElementById("openPayDate").value || null,
      notes: document.getElementById("openNotes").value.trim()
    };
    if (!payload.siteId) {
      alert("Choose a site for this open shift (add one under the employer in the Employers tab if none exist yet).");
      return;
    }
    if (id) {
      const idx = data.openShifts.findIndex((c) => c.id === id);
      data.openShifts[idx] = { ...data.openShifts[idx], ...payload };
    } else {
      data.openShifts.push({ id: uid(), ...payload });
    }
    saveData();
    closeModal("openModal");
    toast("Saved");
    refreshCurrentView();
  });

  document.getElementById("deleteOpenBtn").addEventListener("click", () => {
    const id = document.getElementById("openId").value;
    if (confirm("Remove this open shift?")) {
      data.openShifts = data.openShifts.filter((c) => c.id !== id);
      saveData();
      closeModal("openModal");
      toast("Removed");
      refreshCurrentView();
    }
  });

  document.getElementById("fabAddOpen").addEventListener("click", () => openOpenModal(null));

  // ---------- Rendering: Calendar ----------
  let calYear = new Date().getFullYear();
  let calMonth = new Date().getMonth(); // 0-indexed

  // Builds a month grid into any grid/title element pair. Shared by the
  // navigable Calendar tab (calGrid/calTitle, any month) and the Dashboard's
  // fixed at-a-glance widget (dashCalGrid/dashCalTitle, always the current month).
  function renderCalendarGrid(gridId, titleId, year, month) {
    const grid = document.getElementById(gridId);
    const titleEl = document.getElementById(titleId);
    if (!grid) return;
    const first = new Date(year, month, 1);
    if (titleEl) titleEl.textContent = first.toLocaleDateString(undefined, { month: "long", year: "numeric" });

    const firstWeekday = (first.getDay() + 6) % 7; // 0=Mon .. 6=Sun
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();
    const todayIso = todayStr();
    const totalCells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;

    grid.innerHTML = "";
    for (let i = 0; i < totalCells; i++) {
      const dayNum = i - firstWeekday + 1;
      let cellYear = year, cellMonth = month, cellDay = dayNum, outside = false;
      if (dayNum < 1) {
        outside = true;
        cellMonth = month - 1;
        cellDay = daysInPrevMonth + dayNum;
        if (cellMonth < 0) { cellMonth = 11; cellYear -= 1; }
      } else if (dayNum > daysInMonth) {
        outside = true;
        cellMonth = month + 1;
        cellDay = dayNum - daysInMonth;
        if (cellMonth > 11) { cellMonth = 0; cellYear += 1; }
      }
      const iso = isoDate(new Date(cellYear, cellMonth, cellDay));
      const status = dayStatus(iso);
      const cell = document.createElement("div");
      cell.className = "cal-cell" + (outside ? " cal-outside" : "") + (status ? " cal-" + status : "") + (iso === todayIso ? " cal-today" : "");
      cell.innerHTML = `<span class="cal-daynum">${cellDay}</span>`;
      cell.addEventListener("click", () => openDayModal(iso));
      grid.appendChild(cell);
    }
  }

  function renderCalendar() {
    renderCalendarGrid("calGrid", "calTitle", calYear, calMonth);
  }

  // Dashboard's calendar is intentionally fixed to today's month (no prev/next) —
  // it's an at-a-glance widget; full navigation lives in the Calendar tab.
  function renderDashboardCalendar() {
    const now = new Date();
    renderCalendarGrid("dashCalGrid", "dashCalTitle", now.getFullYear(), now.getMonth());
  }

  document.getElementById("calPrevBtn").addEventListener("click", () => {
    calMonth -= 1;
    if (calMonth < 0) { calMonth = 11; calYear -= 1; }
    renderCalendar();
  });
  document.getElementById("calNextBtn").addEventListener("click", () => {
    calMonth += 1;
    if (calMonth > 11) { calMonth = 0; calYear += 1; }
    renderCalendar();
  });

  // ---------- Day Detail Modal ----------
  let dayModalDate = null;
  const dayStatusText = { red: "Marked as a day off", green: "You have a shift scheduled", orange: "You have an open shift candidate pending a decision" };

  function openDayModal(dateStr) {
    dayModalDate = dateStr;
    document.getElementById("dayModalTitle").textContent = dateLabel(dateStr);
    const status = dayStatus(dateStr);
    document.getElementById("dayModalStatus").textContent = dayStatusText[status] || "Free — nothing scheduled.";

    const listEl = document.getElementById("dayModalList");
    listEl.innerHTML = "";
    const items = [
      ...data.shifts.filter((s) => s.date === dateStr).map((s) => ({ kind: "shift", s })),
      ...data.openShifts.filter((s) => s.date === dateStr).map((s) => ({ kind: "open", s }))
    ];
    if (items.length === 0) {
      listEl.classList.add("empty");
      listEl.textContent = "Nothing on this day.";
    } else {
      listEl.classList.remove("empty");
      items.forEach(({ kind, s }) => {
        const { pay } = calcPay(s);
        const card = document.createElement("div");
        card.className = "item-card";
        card.innerHTML = `
          <div class="item-main">
            <div class="item-title">${escapeHtml(siteLabel(s.siteId))} ${kind === "shift" ? statusBadgeHtml(s) : '<span class="status-badge status-scheduled">Open Candidate</span>'}</div>
            <div class="item-sub">${s.start} · ${fmtMoney(pay)}</div>
          </div>`;
        card.addEventListener("click", () => {
          closeModal("dayModal");
          if (kind === "shift") openShiftModal(s.id);
          else openOpenModal(s.id);
        });
        listEl.appendChild(card);
      });
    }

    document.getElementById("dayToggleOffBtn").textContent = isDayOff(dateStr) ? "Unmark Day Off" : "Mark as Day Off";
    openModal("dayModal");
  }

  document.getElementById("dayToggleOffBtn").addEventListener("click", () => {
    if (!dayModalDate) return;
    if (data.settings.daysOff.includes(dayModalDate)) {
      data.settings.daysOff = data.settings.daysOff.filter((d) => d !== dayModalDate);
      toast("Day off removed");
    } else {
      data.settings.daysOff.push(dayModalDate);
      toast("Day off added");
    }
    saveData();
    closeModal("dayModal");
    renderCalendar();
  });

  document.getElementById("dayAddShiftBtn").addEventListener("click", () => {
    const presetDate = dayModalDate;
    closeModal("dayModal");
    openShiftModal(null, presetDate);
  });

  // ---------- Modal generic ----------
  function openModal(id) { document.getElementById(id).classList.add("open"); }
  function closeModal(id) { document.getElementById(id).classList.remove("open"); }

  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.dataset.close;
      closeModal(targetId);
      if (targetId === "siteModal" && siteModalReturnEmployerId) {
        const returnTo = siteModalReturnEmployerId;
        siteModalReturnEmployerId = null;
        openEmployerModal(returnTo);
      }
    });
  });
  document.querySelectorAll(".modal").forEach((modal) => {
    modal.addEventListener("click", (e) => {
      if (e.target !== modal) return;
      closeModal(modal.id);
      if (modal.id === "siteModal" && siteModalReturnEmployerId) {
        const returnTo = siteModalReturnEmployerId;
        siteModalReturnEmployerId = null;
        openEmployerModal(returnTo);
      }
    });
  });

  function refreshCurrentView() {
    const active = views.find((v) => document.getElementById("view-" + v).classList.contains("active"));
    switchView(active || "dashboard");
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  }

  // ---------- Auth ----------
  let authMode = "signin";

  function showAuthScreen() {
    currentUserId = null;
    document.getElementById("signOutBtn").hidden = true;
    document.getElementById("signOutBtn2").hidden = true;
    document.getElementById("authScreen").classList.remove("hidden");
  }

  function hideAuthScreen() {
    document.getElementById("authScreen").classList.add("hidden");
  }

  function updateCloudStatusText(email) {
    const el = document.getElementById("cloudStatusText");
    if (!CLOUD_ENABLED) {
      el.textContent = "Local mode — cloud sync not configured. See README.md to connect a free Supabase project.";
    } else if (email) {
      el.textContent = `Connected as ${email}. Your data syncs automatically.`;
    } else {
      el.textContent = "Cloud sync configured — sign in to start syncing.";
    }
  }

  async function onSignedIn(session) {
    currentUserId = session.user.id;
    document.getElementById("signOutBtn").hidden = false;
    document.getElementById("signOutBtn2").hidden = false;
    updateCloudStatusText(session.user.email);
    await cloudLoadData();
    hideAuthScreen();
    startApp();
  }

  async function doSignOut() {
    if (sb) await sb.auth.signOut();
  }
  document.getElementById("signOutBtn").addEventListener("click", doSignOut);
  document.getElementById("signOutBtn2").addEventListener("click", doSignOut);

  document.getElementById("authToggleBtn").addEventListener("click", () => {
    authMode = authMode === "signin" ? "signup" : "signin";
    document.getElementById("authSubmitBtn").textContent = authMode === "signin" ? "Sign In" : "Create Account";
    document.getElementById("authToggleBtn").textContent = authMode === "signin" ? "Need an account? Sign Up" : "Already have an account? Sign In";
    document.getElementById("authError").hidden = true;
  });

  document.getElementById("authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!sb) return;
    const email = document.getElementById("authEmail").value.trim();
    const password = document.getElementById("authPassword").value;
    const errEl = document.getElementById("authError");
    errEl.hidden = true;
    const btn = document.getElementById("authSubmitBtn");
    btn.disabled = true;
    try {
      if (authMode === "signin") {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { data: signUpData, error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        if (!signUpData.session) {
          errEl.hidden = false;
          errEl.textContent = "Account created — check your email to confirm, then sign in.";
          authMode = "signin";
          document.getElementById("authSubmitBtn").textContent = "Sign In";
          document.getElementById("authToggleBtn").textContent = "Need an account? Sign Up";
        }
      }
    } catch (err) {
      errEl.hidden = false;
      errEl.textContent = err.message || "Something went wrong.";
    } finally {
      btn.disabled = false;
    }
  });

  function startApp() {
    renderDashboard();
  }

  // ---------- Init ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW registration failed", e));
    });
  }

  async function boot() {
    updateCloudStatusText(null);
    if (!CLOUD_ENABLED) {
      hideAuthScreen();
      data = loadData();
      startApp();
      return;
    }
    const { data: sessionResult } = await sb.auth.getSession();
    if (sessionResult && sessionResult.session) {
      await onSignedIn(sessionResult.session);
    } else {
      showAuthScreen();
    }
    sb.auth.onAuthStateChange((_event, session) => {
      if (session && !currentUserId) onSignedIn(session);
      if (!session && currentUserId) {
        currentUserId = null;
        data = cloneDefault();
        updateCloudStatusText(null);
        showAuthScreen();
      }
    });
  }

  boot();
})();
