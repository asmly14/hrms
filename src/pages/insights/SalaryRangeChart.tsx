/**
 * M8 — Horizontal salary range chart (recharts stacked bars):
 * min → p25 → p75 → max with a highlighted p25–p75 core band, a dashed median
 * marker and an optional "current salary" marker for context.
 */
import { Bar, BarChart, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { fmtRM } from '@/lib/utils';

interface Props {
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  /** Optional employee/current salary marker (red line). */
  current?: number;
}

const shortRM = (v: number) => `RM ${Number(v).toLocaleString('en-MY', { maximumFractionDigits: 0 })}`;

export default function SalaryRangeChart({ min, p25, median, p75, max, current }: Props) {
  const row = {
    name: 'range',
    offset: min,
    lower: Math.max(0, p25 - min),
    core: Math.max(0, p75 - p25),
    upper: Math.max(0, max - p75),
  };
  const stats = [
    { label: 'Min', value: min },
    { label: 'P25', value: p25 },
    { label: 'Median', value: median },
    { label: 'P75', value: p75 },
    { label: 'Max', value: max },
  ];

  return (
    <div className="space-y-3">
      <div className="h-[120px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            layout="vertical"
            data={[row]}
            margin={{ top: 22, right: 16, bottom: 0, left: 8 }}
            barCategoryGap="40%"
          >
            <XAxis
              type="number"
              domain={[0, Math.ceil(max * 1.1)]}
              ticks={[min, p25, median, p75, max]}
              tickFormatter={shortRM}
              tick={{ fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis type="category" dataKey="name" hide />
            <Bar dataKey="offset" stackId="range" fill="transparent" isAnimationActive={false} barSize={26} />
            <Bar dataKey="lower" stackId="range" fill="#fde68a" barSize={26} />
            <Bar dataKey="core" stackId="range" fill="#f59e0b" barSize={26} />
            <Bar dataKey="upper" stackId="range" fill="#fde68a" barSize={26} radius={[0, 8, 8, 0]} />
            <ReferenceLine
              x={median}
              stroke="#44403c"
              strokeWidth={2}
              strokeDasharray="4 3"
              label={{ value: 'Median', position: 'top', fontSize: 11, fill: '#44403c' }}
            />
            {current != null && current > 0 && (
              <ReferenceLine
                x={current}
                stroke="#dc2626"
                strokeWidth={2}
                label={{ value: 'Current', position: 'top', fontSize: 11, fill: '#dc2626' }}
              />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {stats.map((s) => (
          <div
            key={s.label}
            className={
              s.label === 'Median'
                ? 'rounded-lg bg-amber-100 px-3 py-2'
                : 'rounded-lg bg-muted px-3 py-2'
            }
          >
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{s.label}</p>
            <p className="text-sm font-semibold tabular-nums">{fmtRM(s.value)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
