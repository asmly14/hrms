/**
 * Stacked bar chart for the 'Payroll cost by department & cost centre' report:
 * each department's total employer cost decomposed into gross wages, employer
 * statutory (EPF/SOCSO/EIS), HRD levy and claims. Warm low-saturation palette.
 */
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DeptCostRow } from './reportBuilders';

const shortRM = (v: number) =>
  `RM ${Number(v).toLocaleString('en-MY', { maximumFractionDigits: 0 })}`;

export default function DeptCostChart({ rows }: { rows: DeptCostRow[] }) {
  const data = rows.map((r) => ({
    name: r.department.length > 18 ? `${r.department.slice(0, 17)}…` : r.department,
    'Gross wages': r.gross,
    'Employer statutory': r.erStatutory,
    'HRD levy': r.hrd,
    Claims: r.claims,
  }));

  return (
    <div className="h-[300px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 8 }} barCategoryGap="28%">
          <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#e7e5e4" />
          <XAxis dataKey="name" tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
          <YAxis tickFormatter={shortRM} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} width={72} />
          <Tooltip
            formatter={(value: number, name: string) => [shortRM(value), name]}
            cursor={{ fill: '#fafaf9' }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="Gross wages" stackId="cost" fill="#f59e0b" isAnimationActive={false} />
          <Bar dataKey="Employer statutory" stackId="cost" fill="#b45309" isAnimationActive={false} />
          <Bar dataKey="HRD levy" stackId="cost" fill="#78716c" isAnimationActive={false} />
          <Bar dataKey="Claims" stackId="cost" fill="#4d7c0f" radius={[6, 6, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
