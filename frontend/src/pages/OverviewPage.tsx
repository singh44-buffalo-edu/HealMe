/**
 * OverviewPage — the "Health overview" dashboard (route /overview).
 *
 * Implements the design handoff's `Web - Dashboard.dc.html` screen: status
 * strip, 4-card metric sparkline grid, today's medications, latest check-in,
 * recent symptoms, weight / mood-energy / sleep charts, recent-labs table.
 * The design's live-glucose tile, dispenser states and AI-insights stack are
 * deliberately NOT rendered — their backends don't exist yet and screens are
 * never faked ahead of them (CLAUDE.md §2 "Design system").
 *
 * Architecture: leaf route inside App.tsx's shell; reads FHIR via useMedplum()
 * plus the shared query/derivation helpers in ../fhir.ts. Read-only — this
 * page never writes; dose logging lives on AdherencePage ("Log now" links there).
 *
 * FHIR reads (all bounded, single-user project so one page suffices):
 * - Observation      date=ge{90d} _count=1000 _sort=-date — one search, fanned
 *   out client-side into weight (LOINC 29463-7), mood/energy/sleep-duration/
 *   symptom (local CS_OBS codes) and lab rows (category `laboratory`).
 *   Newest-first sort so that if the window ever exceeds the 1000-result page
 *   max, the OLDEST edge drops (disclosed by a mono note) — never today's
 *   data; the page reverses back to ascending before deriving anything.
 * - MedicationRequest + Medication + cartridge Devices via loadMeds().
 * - MedicationAdministration via loadAdmins(30) — last 30 days of dose logs.
 * - QuestionnaireResponse _sort=-authored _count=1 — the latest check-in.
 *
 * Derived-state rules shared with AdherencePage (medical-safety semantics):
 * - A dose slot with no MedicationAdministration is computed live as
 *   upcoming/due/overdue from the schedule — absence is NEVER persisted as a
 *   missed dose (FHIR-MAPPING §3). "due" = past slot within
 *   OVERDUE_GRACE_MINUTES; "overdue" = beyond it; "skipped"/"missed" exist
 *   only as explicit not-done logs (statusReason user-skipped /
 *   user-marked-missed).
 * - Charts carry no reference bands or targets: thresholds are set with a
 *   clinician, never fabricated by the UI (spec SR-3). The lab table's
 *   "Reference" column is the range stated on the source report — the only
 *   range this page ever shows.
 * - Weight is a plain 90-day delta — no goal weight or diet framing
 *   (neutral-weight rule, CLAUDE.md §6).
 * - Everything here is computed client-side from records; nothing is
 *   AI-derived, so no indigo/✦ labeling appears (three-data-classes rule).
 */
import { Alert, Loader } from '@mantine/core';
import { normalizeErrorString } from '@medplum/core';
import type { MedicationAdministration, Observation, QuestionnaireResponse } from '@medplum/fhirtypes';
import { useMedplum } from '@medplum/react';
import { IconStack2 } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { CardTitle, DsCard, PageHeader, Sparkline, StatusDot, StatusStrip, TableRow } from '../components/ds';
import {
  CS_OBS,
  LOINC,
  OVERDUE_GRACE_MINUTES,
  adherenceStats,
  adminForSlot,
  loadAdmins,
  loadMeds,
  localDateString,
  slotsForDate,
  summarizeDays,
} from '../fhir';
import type { CartridgeInfo, MedInfo } from '../fhir';
import { T, mono } from '../tokens';
import { useIsMobile } from '../useIsMobile';

interface Point {
  date: string;
  value: number;
}

interface LabRow {
  name: string;
  date: string;
  value: string;
  range: string;
  flagged: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** ISO timestamp → 'Jul 13 08:05' in LOCAL time (year only when not current) — same approach as
 * VitalsPage's fmtWhen. Date-only strings (YYYY-MM-DD) parse at local midday so the calendar day
 * never shifts across timezones. Always parse with new Date(); never render sliced ISO strings. */
function fmtWhen(iso: string): string {
  const hasTime = iso.length >= 16;
  const d = new Date(hasTime ? iso : `${iso.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  const year = d.getFullYear() === new Date().getFullYear() ? '' : ` ${d.getFullYear()}`;
  const time = hasTime
    ? ` ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : '';
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year}${time}`;
}

/** Local calendar day only — 'Jul 12' (year appended when not current). */
function fmtDay(iso: string): string {
  const d = new Date(iso.length >= 16 ? iso : `${iso.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  const year = d.getFullYear() === new Date().getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year}`;
}

// Shared recharts chrome per the design system: mono axis ticks, borderless
// tooltip on the card shadow (charts get hairlines/whisper grays, never chrome color).
const AXIS_TICK = { fontFamily: T.mono, fontSize: 10, fill: T.quaternary };
const CHART_MARGIN = { top: 6, right: 6, left: 0, bottom: 0 };
const TOOLTIP_STYLE = {
  border: 'none',
  borderRadius: 10,
  boxShadow: T.shadowCard,
  fontFamily: T.mono,
  fontSize: 11,
};

/**
 * Health-overview dashboard page. Loads everything once on mount (window is a
 * fixed 90 days — the owner's default review span, CLAUDE.md §8); all cards
 * below render from that snapshot except TodayMedsCard, which keeps its own
 * 60s clock for live due/overdue states. Failure mode: any search error
 * replaces the whole page with a single alert.
 */
export function OverviewPage() {
  const medplum = useMedplum();
  const isMobile = useIsMobile();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [capped, setCapped] = useState(false);
  const [weight, setWeight] = useState<Point[]>([]);
  const [mood, setMood] = useState<Point[]>([]);
  const [energy, setEnergy] = useState<Point[]>([]);
  const [sleep, setSleep] = useState<Point[]>([]);
  const [symptoms, setSymptoms] = useState<Observation[]>([]);
  const [labs, setLabs] = useState<LabRow[]>([]);
  const [checkin, setCheckin] = useState<QuestionnaireResponse>();
  const [summary, setSummary] = useState<string>('');
  const [medList, setMedList] = useState<MedInfo[]>([]);
  const [adminList, setAdminList] = useState<MedicationAdministration[]>([]);

  useEffect(() => {
    (async () => {
      try {
        // 90-day query window. The `ge` bound is sliced from UTC ISO, so it can
        // start up to one local day early — a harmless over-fetch. `_count: 1000`
        // is Medplum's max page size (CLAUDE.md §5); sorted -date so an
        // overflowing window clips its oldest edge, with the cap guard below
        // disclosing it instead of silently dropping data.
        const since = new Date();
        since.setDate(since.getDate() - 90);
        const sinceStr = since.toISOString().slice(0, 10);

        const [observations, meds, admins, responses] = await Promise.all([
          medplum.searchResources('Observation', {
            date: `ge${sinceStr}`,
            _count: '1000',
            _sort: '-date',
          }),
          loadMeds(medplum),
          loadAdmins(medplum, 30),
          medplum.searchResources('QuestionnaireResponse', { _sort: '-authored', _count: '1' }),
        ]);

        // Cheap truncation guard: exactly one full page means the window
        // (probably) holds more than the page max.
        setCapped(observations.length === 1000);
        // Everything below expects oldest-first (deltas, slice(-14), the
        // per-list reverse()s) — restore ascending order once, here.
        observations.reverse();

        const weightPts: Point[] = [];
        const moodPts: Point[] = [];
        const energyPts: Point[] = [];
        const sleepPts: Point[] = [];
        const symptomObs: Observation[] = [];
        const labRows: LabRow[] = [];

        // Fan the single Observation search out by code. Codes per FHIR-MAPPING
        // §2/§4: weight = verified LOINC 29463-7; mood/energy/sleep-duration/
        // symptom = project-local CS_OBS codes (never presented as LOINC).
        // Lab rows = category `laboratory`; their flagged state comes from the
        // report's own referenceRange — the UI never invents a range (SR-3).
        for (const obs of observations) {
          const coding = obs.code?.coding?.[0];
          const when = (obs.effectiveDateTime ?? obs.effectivePeriod?.end ?? '').slice(0, 10);
          if (!when) continue;
          if (coding?.system === LOINC && coding.code === '29463-7' && obs.valueQuantity?.value != null) {
            weightPts.push({ date: when, value: obs.valueQuantity.value });
          } else if (coding?.system === CS_OBS && coding.code === 'mood' && obs.valueInteger != null) {
            moodPts.push({ date: when, value: obs.valueInteger });
          } else if (coding?.system === CS_OBS && coding.code === 'energy' && obs.valueInteger != null) {
            energyPts.push({ date: when, value: obs.valueInteger });
          } else if (coding?.system === CS_OBS && coding.code === 'sleep-duration' && obs.valueQuantity?.value != null) {
            sleepPts.push({ date: when, value: obs.valueQuantity.value });
          } else if (coding?.system === CS_OBS && coding.code === 'symptom') {
            symptomObs.push(obs);
          } else if (
            obs.category?.some((c) => c.coding?.some((cc) => cc.code === 'laboratory')) &&
            obs.valueQuantity?.value != null
          ) {
            const range = obs.referenceRange?.[0];
            const low = range?.low?.value;
            const high = range?.high?.value;
            const v = obs.valueQuantity.value;
            labRows.push({
              name: obs.code?.text ?? coding?.display ?? coding?.code ?? 'Lab',
              date: when,
              value: `${v} ${obs.valueQuantity.unit ?? ''}`.trim(),
              range: low != null && high != null ? `${low}–${high} ${range?.low?.unit ?? ''}`.trim() : '—',
              flagged: low != null && high != null ? v < low || v > high : false,
            });
          }
        }

        // Presentation windows per the Dashboard design: sleep = last 14
        // nights; symptoms (8) and labs (12) newest-first — the fan-out above
        // ran oldest-first (post-reverse), hence the per-list reverse().
        setWeight(weightPts);
        setMood(moodPts);
        setEnergy(energyPts);
        setSleep(sleepPts.slice(-14));
        setSymptoms(symptomObs.reverse().slice(0, 8));
        setLabs(labRows.reverse().slice(0, 12));
        setCheckin(responses[0]);
        setMedList(meds);
        setAdminList(admins);

        // One-line summary card — plain client-side facts, no AI.
        const stats = adherenceStats(meds, admins, summarizeDays(meds, admins, 30));
        const latestWeight = weightPts[weightPts.length - 1];
        const firstWeight = weightPts[0];
        const delta =
          latestWeight && firstWeight
            ? (latestWeight.value - firstWeight.value).toFixed(1)
            : undefined;
        const parts: string[] = [];
        if (stats.pct !== null) parts.push(`adherence ${stats.pct}% (30d)`);
        if (stats.streak) parts.push(`${stats.streak}-day streak`);
        if (latestWeight) {
          parts.push(
            `weight ${latestWeight.value} kg${delta !== undefined ? ` (${Number(delta) >= 0 ? '+' : ''}${delta} kg over 90d)` : ''}`
          );
        }
        const lastMood = moodPts[moodPts.length - 1];
        if (lastMood) parts.push(`mood ${lastMood.value}/10`);
        setSummary(parts.length ? parts.join(' · ') : 'No data yet — start logging to see your overview.');
      } catch (err) {
        setError(normalizeErrorString(err));
      } finally {
        setLoading(false);
      }
    })();
  }, [medplum]);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '80px 0' }}>
        <Loader color={T.green} size="sm" />
      </div>
    );
  }
  if (error) {
    return (
      <Alert color="red" title="Could not load overview">
        {error}
      </Alert>
    );
  }

  const flaggedLabs = labs.filter((l) => l.flagged).length;
  const hasData = !summary.startsWith('No data yet');

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: isMobile ? 16 : 20,
        // Mobile shell floats a blurred pill tab bar over the page bottom —
        // clear it plus the home-indicator safe area.
        paddingBottom: isMobile ? 'calc(90px + env(safe-area-inset-bottom))' : undefined,
      }}
    >
      <PageHeader
        title="Health overview"
        subtitle={`${fmtDay(localDateString(new Date()))} · 90-day window`}
      />

      {capped ? (
        <span style={mono(10.5, 400, T.quaternary)}>
          1,000-result cap reached — the oldest data in this 90-day window is not shown.
        </span>
      ) : null}

      <StatusStrip
        dotColor={!hasData ? T.disabled : flaggedLabs ? T.watch : T.inRange}
        headline={summary}
        watch={
          flaggedLabs
            ? `${flaggedLabs} lab value${flaggedLabs > 1 ? 's' : ''} outside reference range`
            : undefined
        }
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)',
          gap: isMobile ? 12 : 16,
        }}
      >
        <MetricCard label="Weight" range="90D" unit="kg" points={weight} accent={T.metric.weight} />
        <MetricCard label="Sleep" range="14N" unit="h" points={sleep} accent={T.metric.sleep} />
        <MetricCard label="Mood" range="90D" unit="/10" points={mood} accent={T.metric.mood} />
        <MetricCard label="Energy" range="90D" unit="/10" points={energy} accent={T.metric.energy} />
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : '1.25fr 1fr',
          gap: 16,
          alignItems: 'start',
        }}
      >
        <TodayMedsCard meds={medList} admins={adminList} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <DsCard padding={20} gap={10}>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <CardTitle size={14}>Latest check-in</CardTitle>
              {checkin ? (
                <span style={{ marginLeft: 'auto', ...mono(10, 400, T.quaternary) }}>
                  {checkin.authored ? fmtWhen(checkin.authored) : ''}
                </span>
              ) : null}
            </div>
            {checkin ? (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {checkin.item?.map((item) => {
                  const a = item.answer?.[0];
                  const value = a?.valueInteger ?? a?.valueDecimal ?? a?.valueString ?? a?.valueBoolean;
                  return value !== undefined && value !== '' ? (
                    <div
                      key={item.linkId}
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 10,
                        padding: '7px 0',
                        borderTop: `1px solid ${T.band}`,
                      }}
                    >
                      <span style={{ width: 110, flexShrink: 0, ...mono(10.5, 400, T.tertiary) }}>
                        {item.linkId}
                      </span>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{String(value)}</span>
                    </div>
                  ) : null;
                })}
              </div>
            ) : (
              <span style={mono(11, 400, T.quaternary)}>
                No check-in yet — do your first one under Daily check-in.
              </span>
            )}
          </DsCard>

          <DsCard padding={20} gap={10}>
            <CardTitle size={14}>Recent symptoms</CardTitle>
            {symptoms.length === 0 ? (
              <span style={mono(11, 400, T.quaternary)}>No symptoms logged in the last 90 days.</span>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {symptoms.map((s) => (
                  <div
                    key={s.id}
                    style={{
                      display: 'flex',
                      alignItems: 'baseline',
                      gap: 10,
                      padding: '7px 0',
                      borderTop: `1px solid ${T.band}`,
                    }}
                  >
                    <span style={{ width: 80, flexShrink: 0, ...mono(10.5, 400, T.quaternary) }}>
                      {s.effectiveDateTime ? fmtDay(s.effectiveDateTime) : ''}
                    </span>
                    <span style={{ fontSize: 13, fontWeight: 500, letterSpacing: '-.01em' }}>
                      {s.valueString}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </DsCard>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',
          gap: 16,
          alignItems: 'start',
        }}
      >
        <ChartCard title="Weight" range="kg · 90d" data={weight} color={T.metric.weight} domain={['auto', 'auto']} />
        <DsCard padding={20} gap={12}>
          <div style={{ display: 'flex', alignItems: 'baseline' }}>
            <CardTitle>Mood & energy</CardTitle>
            <span style={{ marginLeft: 'auto', ...mono(10, 400, T.quaternary) }}>1–10 · 90d</span>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={mergeSeries(mood, energy)} margin={CHART_MARGIN}>
              <XAxis
                dataKey="date"
                tick={AXIS_TICK}
                tickFormatter={(d: string) => fmtDay(d)}
                minTickGap={24}
                axisLine={false}
                tickLine={false}
              />
              <YAxis domain={[0, 10]} tick={AXIS_TICK} width={28} axisLine={false} tickLine={false} />
              <ChartTooltip contentStyle={TOOLTIP_STYLE} labelFormatter={(d) => fmtDay(String(d))} />
              <Line
                type="monotone"
                dataKey="mood"
                stroke={T.metric.mood}
                strokeWidth={1.7}
                strokeLinecap="round"
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="energy"
                stroke={T.metric.energy}
                strokeWidth={1.7}
                strokeLinecap="round"
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
          <div style={{ display: 'flex', gap: 12 }}>
            <span style={mono(9.5, 400, T.tertiary)}>
              <span style={{ color: T.metric.mood }}>▮</span> mood
            </span>
            <span style={mono(9.5, 400, T.tertiary)}>
              <span style={{ color: T.metric.energy }}>▮</span> energy
            </span>
          </div>
        </DsCard>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : '1fr 1.25fr',
          gap: 16,
          alignItems: 'start',
        }}
      >
        <ChartCard
          title="Sleep"
          range="hours · last 14 nights"
          data={sleep}
          color={T.metric.sleep}
          domain={[0, 12]}
        />
        <DsCard flush gap={0}>
          <div style={{ display: 'flex', alignItems: 'center', padding: '18px 22px 12px' }}>
            <CardTitle>Recent labs</CardTitle>
          </div>
          {labs.length === 0 ? (
            <div style={{ padding: '0 22px 18px', ...mono(11, 400, T.quaternary) }}>
              No lab results in the last 90 days — upload a report under Documents.
            </div>
          ) : (
            <>
              <TableRow columns={LAB_COLS} padding="4px 22px 8px" first>
                {['Analyte', 'Date', 'Value', 'Reference'].map((h) => (
                  <span
                    key={h}
                    style={{ ...mono(9.5, 500, T.quaternary), textTransform: 'uppercase', letterSpacing: '.08em' }}
                  >
                    {h}
                  </span>
                ))}
              </TableRow>
              {labs.map((row, i) => (
                <TableRow key={i} columns={LAB_COLS} padding="10px 22px">
                  <span style={{ fontSize: 13, fontWeight: 500, letterSpacing: '-.01em' }}>{row.name}</span>
                  <span style={mono(10.5, 400, T.quaternary)}>{fmtDay(row.date)}</span>
                  <span style={mono(11.5, 500, row.flagged ? T.outOfRange : T.ink)}>{row.value}</span>
                  <span style={mono(10.5, 400, T.quaternary)}>{row.range}</span>
                </TableRow>
              ))}
            </>
          )}
        </DsCard>
      </div>
    </div>
  );
}

// Labs table grid template: analyte | date | value | reference.
const LAB_COLS = 'minmax(0,1.3fr) 80px minmax(0,.8fr) minmax(0,.9fr)';

/** Outer-join mood and energy points by calendar day so recharts can draw both
 * lines on one chart. A day with only one metric leaves the other undefined —
 * a gap in that line — rather than fabricating a value. */
function mergeSeries(mood: Point[], energy: Point[]) {
  const byDate = new Map<string, { date: string; mood?: number; energy?: number }>();
  for (const p of mood) byDate.set(p.date, { ...(byDate.get(p.date) ?? { date: p.date }), mood: p.value });
  for (const p of energy) byDate.set(p.date, { ...(byDate.get(p.date) ?? { date: p.date }), energy: p.value });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Right-aligned brand-green nav link used in card headers ("All meds →"). */
function GreenLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      style={{
        marginLeft: 'auto',
        color: T.green,
        textDecoration: 'none',
        fontSize: 12.5,
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </Link>
  );
}

/** Non-interactive state pill (Upcoming/Taken/…) matching the design's chip
 * shape — read-only counterpart to the actionable "Log now" link. */
function StaticChip({ fg, bg, children }: { fg: string; bg: string; children: ReactNode }) {
  return (
    <span
      style={{
        fontSize: 12,
        fontWeight: 500,
        color: fg,
        background: bg,
        borderRadius: 16,
        padding: '5px 13px',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

/** Standard metric sparkline card — measured data class (ink + mono). */
function MetricCard({
  label,
  range,
  unit,
  points,
  accent,
}: {
  label: string;
  range: string;
  unit: string;
  points: Point[];
  accent: string;
}) {
  const latest = points[points.length - 1];
  const delta = points.length >= 2 ? points[points.length - 1].value - points[0].value : undefined;
  const deltaText =
    delta === undefined
      ? undefined
      : `${delta >= 0 ? '▴' : '▾'}${Math.abs(delta).toFixed(1).replace(/\.0$/, '')}`;
  return (
    <DsCard padding={18} gap={10}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 12.5, fontWeight: 500, color: T.secondary }}>{label}</span>
        <span style={mono(10, 400, T.quaternary)}>{range}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
        <span style={{ ...mono(28, 500, latest ? T.ink : T.quaternary), letterSpacing: '-.02em' }}>
          {latest ? String(latest.value) : '—'}
        </span>
        {latest ? <span style={mono(11, 400, T.tertiary)}>{unit}</span> : null}
        {deltaText ? (
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
            <StatusDot color={T.disabled} size={6} />
            <span style={mono(10.5, 500, T.tertiary)}>{deltaText}</span>
          </span>
        ) : null}
      </div>
      {/* band={false}: no reference range exists for these metrics — thresholds are
          set with a clinician, never implied by decoration (CLAUDE.md §9, SR-3). */}
      <Sparkline values={points.map((p) => p.value)} accent={accent} height={30} band={false} />
      <span style={mono(9.5, 400, T.quaternary)}>{latest ? `latest ${fmtDay(latest.date)}` : 'no data yet'}</span>
    </DsCard>
  );
}

/** Read-only view of today's dose slots derived from already-loaded meds + admins.
 * Logging itself lives on the Medications page — "Log now" links there.
 * Slot states use the shared vocabulary: taken (completed admin), skipped/missed
 * (explicit not-done, split on statusReason), due/overdue (unlogged past slot,
 * split on the 90-min grace), upcoming (future). Life-critical meds get the
 * CRITICAL tag and a red "Log now" button once overdue — display prominence
 * only, never dose logic (CLAUDE.md §8). */
function TodayMedsCard({ meds, admins }: { meds: MedInfo[]; admins: MedicationAdministration[] }) {
  const isMobile = useIsMobile();
  const [now, setNow] = useState(() => new Date());

  // Dose status depends on wall-clock time — same 60s ticker as AdherencePage so
  // an open tab transitions upcoming → due → overdue and "today" rolls over midnight.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const today = localDateString(now);
  const slots = slotsForDate(meds, today);
  const takenCount = slots.filter((s) => adminForSlot(admins, s)?.status === 'completed').length;

  const carts = new Map<string, CartridgeInfo>();
  for (const m of meds) {
    if (m.cartridge?.device.id) carts.set(m.cartridge.device.id, m.cartridge);
  }
  const lows = [...carts.values()].filter((c) => c.low);

  return (
    <DsCard flush gap={0}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '18px 22px 12px' }}>
        <CardTitle>Today's medications</CardTitle>
        {slots.length > 0 ? (
          <span style={{ marginLeft: 10, ...mono(10.5, 400, T.tertiary) }}>
            {takenCount} of {slots.length} taken
          </span>
        ) : null}
        <GreenLink to="/">All meds →</GreenLink>
      </div>

      {meds.length === 0 ? (
        <div style={{ padding: '14px 22px 18px', borderTop: `1px solid ${T.band}`, ...mono(11, 400, T.quaternary) }}>
          No active medications.
        </div>
      ) : slots.length === 0 ? (
        <div style={{ padding: '14px 22px 18px', borderTop: `1px solid ${T.band}`, ...mono(11, 400, T.quaternary) }}>
          No doses scheduled today.
        </div>
      ) : (
        slots.map((slot) => {
          const admin = adminForSlot(admins, slot);
          const hhmm = slot.time.slice(0, 5);
          let dot: string = T.disabled;
          let state = `next ${hhmm}`;
          let stateColor: string = T.tertiary;
          let action: ReactNode = (
            <StaticChip fg={T.quaternary} bg={T.cardFooter}>
              Upcoming
            </StaticChip>
          );
          if (admin?.status === 'completed') {
            const at = admin.effectiveDateTime
              ? new Date(admin.effectiveDateTime).toTimeString().slice(0, 5)
              : hhmm;
            dot = T.inRange;
            state = `taken ${at} ✓`;
            stateColor = T.inRange;
            action = (
              <StaticChip fg={T.tertiary} bg={T.band}>
                Taken
              </StaticChip>
            );
          } else if (admin?.status === 'not-done') {
            const missed = admin.statusReason?.[0]?.coding?.[0]?.code === 'user-marked-missed';
            dot = missed ? T.outOfRange : T.watch;
            state = missed ? `missed ${hhmm}` : `skipped ${hhmm}`;
            stateColor = missed ? T.outOfRange : T.watch;
            action = (
              <StaticChip fg={T.tertiary} bg={T.band}>
                {missed ? 'Missed' : 'Skipped'}
              </StaticChip>
            );
          } else if (slot.scheduled.getTime() <= now.getTime()) {
            // Same rule as AdherencePage: unlogged past slot is "due" (amber) until
            // OVERDUE_GRACE_MINUTES elapse, then "overdue" (red).
            const overdue =
              now.getTime() - slot.scheduled.getTime() > OVERDUE_GRACE_MINUTES * 60_000;
            dot = overdue ? T.outOfRange : T.watch;
            state = overdue ? `overdue ${hhmm}` : `due ${hhmm}`;
            stateColor = overdue ? T.outOfRange : T.watch;
            action = (
              <Link
                to="/"
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: '#fff',
                  background: overdue && slot.med.lifeCritical ? T.outOfRange : T.ink,
                  borderRadius: 16,
                  padding: '5px 13px',
                  textDecoration: 'none',
                  whiteSpace: 'nowrap',
                  // Mobile: comfortable thumb target, stretched across the action row.
                  ...(isMobile
                    ? {
                        flex: 1,
                        minHeight: 44,
                        boxSizing: 'border-box' as const,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }
                    : null),
                }}
              >
                Log now
              </Link>
            );
          }
          // Shared fragments — identical markup on both layouts.
          const nameDetail = (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
              <span
                style={{
                  fontSize: 13.5,
                  fontWeight: 600,
                  letterSpacing: '-.01em',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                }}
              >
                {slot.med.name}
                {slot.med.lifeCritical ? (
                  <span style={{ ...mono(9.5, 500, T.outOfRange), letterSpacing: '.08em' }}>CRITICAL</span>
                ) : null}
              </span>
              <span style={mono(10.5, 400, T.tertiary)}>
                {hhmm}
                {slot.med.instructions ? ` · ${slot.med.instructions}` : ''}
              </span>
            </div>
          );
          if (isMobile) {
            // Stacked mobile row: dot + name/detail on top, status + action below.
            return (
              <TableRow key={slot.identValue} columns="1fr" padding="12px 22px">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <StatusDot color={dot} size={8} />
                    {nameDetail}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ whiteSpace: 'nowrap', ...mono(11, 500, stateColor) }}>{state}</span>
                    <span
                      style={{
                        marginLeft: 'auto',
                        flex: 1,
                        display: 'flex',
                        justifyContent: 'flex-end',
                      }}
                    >
                      {action}
                    </span>
                  </div>
                </div>
              </TableRow>
            );
          }
          return (
            <TableRow key={slot.identValue} columns="auto 1fr auto auto" padding="12px 22px">
              <StatusDot color={dot} size={8} />
              {nameDetail}
              <span style={mono(11, 500, stateColor)}>{state}</span>
              {action}
            </TableRow>
          );
        })
      )}

      {carts.size > 0 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 22px',
            background: T.cardFooter,
            borderTop: `1px solid ${T.band}`,
          }}
        >
          <IconStack2 size={13} stroke={1.7} color={T.tertiary} />
          <span style={mono(11, 400, lows.length ? T.watch : T.tertiary)}>
            {lows.length
              ? `${lows.length} cartridge${lows.length > 1 ? 's' : ''} low — ${lows.map((c) => c.name).join(', ')}`
              : `${carts.size} cartridge${carts.size > 1 ? 's' : ''} tracked`}
          </span>
          <GreenLink to="/cartridges">Cartridges →</GreenLink>
        </div>
      ) : null}
    </DsCard>
  );
}

/** Single-series line chart card. `domain` is passed per metric on purpose —
 * sleep is pinned to an absolute 0–12h scale so night-to-night variation reads
 * true; weight floats ('auto') around its own range. No reference bands or
 * target lines here (SR-3: thresholds are set with a clinician, never drawn). */
function ChartCard(props: {
  title: string;
  range: string;
  data: Point[];
  color: string;
  domain: [number | string, number | string];
}) {
  return (
    <DsCard padding={20} gap={12}>
      <div style={{ display: 'flex', alignItems: 'baseline' }}>
        <CardTitle>{props.title}</CardTitle>
        <span style={{ marginLeft: 'auto', ...mono(10, 400, T.quaternary) }}>{props.range}</span>
      </div>
      {props.data.length === 0 ? (
        <span style={mono(11, 400, T.quaternary)}>No data yet.</span>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={props.data} margin={CHART_MARGIN}>
            <XAxis
              dataKey="date"
              tick={AXIS_TICK}
              tickFormatter={(d: string) => fmtDay(d)}
              minTickGap={24}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              domain={props.domain as [number, number]}
              tick={AXIS_TICK}
              width={34}
              axisLine={false}
              tickLine={false}
            />
            <ChartTooltip contentStyle={TOOLTIP_STYLE} labelFormatter={(d) => fmtDay(String(d))} />
            <Line
              type="monotone"
              dataKey="value"
              stroke={props.color}
              strokeWidth={1.7}
              strokeLinecap="round"
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </DsCard>
  );
}
