/**
 * M8 — Salary Insights page (/insights/salary).
 * Five tools behind tabs: market salary suggestion, cross-state COL compare,
 * income-standing (B40/M40/T20) placement, internal equity analyzer and the
 * increment simulator. Benchmarks come from @/lib/salaryBenchmark (researched
 * 2025–2026 dataset); statutory figures from @/lib/statutory.
 *
 * Access: Admin/HR only — other roles get a guard card (fail-open while the
 * AuthProvider is not yet wired into App.tsx).
 */
import { useEffect, useState } from 'react';
import { BarChart3, ShieldAlert } from 'lucide-react';
import { useCollection } from '@/lib/db';
import type { Employee } from '@/lib/types';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import SalarySuggestionTool from './SalarySuggestionTool';
import StateCompareTool from './StateCompareTool';
import IncomeStandingTool from './IncomeStandingTool';
import EquityAnalyzer from './EquityAnalyzer';
import IncrementSimulator from './IncrementSimulator';
import { useOptionalRole } from './useOptionalRole';

export default function SalaryInsightsPage() {
  const { items: employees } = useCollection<Employee>('employees');
  const role = useOptionalRole();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setReady(true), 250);
    return () => clearTimeout(t);
  }, []);

  // Role guard: salary insights expose company-wide pay data — Admin/HR only.
  // `role === null` means the AuthProvider isn't wired yet (pre-integration);
  // fail open so the page keeps working until the route guards land.
  if (role != null && role !== 'Admin' && role !== 'HR') {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldAlert />
          </EmptyMedia>
          <EmptyTitle>Restricted to Admin &amp; HR</EmptyTitle>
          <EmptyDescription>
            Salary benchmarks, equity analysis and increment costing expose company-wide pay
            data. Sign in with an Admin or HR account to use these tools.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  // Also treat "seed flag absent" as loading so the empty state doesn't flash
  // on a cold first visit while the async seed module import lands (QA B9).
  const seeded =
    typeof localStorage !== 'undefined' && localStorage.getItem('myhrms:seeded:v1') !== null;
  const loading = (!ready || !seeded) && employees.length === 0;

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-10 w-full max-w-md" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
        </div>
      </div>
    );
  }

  if (employees.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BarChart3 />
          </EmptyMedia>
          <EmptyTitle>No employee data yet</EmptyTitle>
          <EmptyDescription>
            Salary insights need the employee register. The demo seed should load automatically —
            if it did not, reseed from Settings.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Salary Insights</h1>
        <p className="text-sm text-muted-foreground">
          Market benchmarks, cost-of-living comparison, income standing, internal equity and
          increment costing. Benchmarks are the researched 2025–2026 Malaysian dataset in{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">src/lib/salaryBenchmark.ts</code>{' '}
          (indicative, not a paid survey); statutory figures are computed live from{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">src/lib/statutory.ts</code>.
        </p>
      </div>

      <Tabs defaultValue="suggestion" className="space-y-6">
        <TabsList className="h-auto w-full flex-wrap justify-start sm:w-auto">
          <TabsTrigger value="suggestion" className="flex-1 sm:flex-none">
            Salary suggestion
          </TabsTrigger>
          <TabsTrigger value="compare" className="flex-1 sm:flex-none">
            Compare states
          </TabsTrigger>
          <TabsTrigger value="standing" className="flex-1 sm:flex-none">
            Income standing
          </TabsTrigger>
          <TabsTrigger value="equity" className="flex-1 sm:flex-none">
            Internal equity
          </TabsTrigger>
          <TabsTrigger value="increment" className="flex-1 sm:flex-none">
            Increment simulator
          </TabsTrigger>
        </TabsList>
        <TabsContent value="suggestion">
          <SalarySuggestionTool />
        </TabsContent>
        <TabsContent value="compare">
          <StateCompareTool />
        </TabsContent>
        <TabsContent value="standing">
          <IncomeStandingTool />
        </TabsContent>
        <TabsContent value="equity">
          <EquityAnalyzer />
        </TabsContent>
        <TabsContent value="increment">
          <IncrementSimulator />
        </TabsContent>
      </Tabs>
    </div>
  );
}
