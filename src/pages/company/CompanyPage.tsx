/**
 * Company Setup — /company.
 *
 * Deep per-company customization for the ACTIVE tenant: profile & statutory
 * numbers, branding studio + number formats, module feature toggles, work &
 * payroll policy, and the custom employee-fields builder. Everything persists
 * through the tenant layer (upsertCompany + refreshCompanies), layered over
 * the defaults per docs/tenant-api.md §3.
 *
 * Audience: Admin / HR of the active company (SuperAdmin edits whichever
 * company they have entered; the system view shows a picker prompt).
 */
import { Link, useSearchParams } from 'react-router-dom';
import { AppWindow, Building2, CalendarClock, ListPlus, Palette } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTenant } from '@/lib/tenantContext';
import { cn } from '@/lib/utils';
import { useCompanyBranding } from './branding';
import BrandingSection from './sections/BrandingSection';
import CustomFieldsSection from './sections/CustomFieldsSection';
import ModulesSection from './sections/ModulesSection';
import PolicySection from './sections/PolicySection';
import ProfileSection from './sections/ProfileSection';

const TABS = [
  { value: 'profile', label: 'Profile', icon: Building2 },
  { value: 'branding', label: 'Branding', icon: Palette },
  { value: 'modules', label: 'Modules', icon: AppWindow },
  { value: 'policy', label: 'Work & Payroll Policy', icon: CalendarClock },
  { value: 'fields', label: 'Custom Fields', icon: ListPlus },
] as const;

type TabValue = (typeof TABS)[number]['value'];

const PLAN_CLS: Record<string, string> = {
  enterprise: 'border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  pro: 'border-transparent bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300',
  free: 'border-transparent bg-muted text-muted-foreground',
};

export default function CompanyPage() {
  const { companies, activeCompany, isSystemView, setActiveCompany } = useTenant();
  const [params, setParams] = useSearchParams();

  // Applies the active company's branding (accent color) to :root CSS vars —
  // the integration agent should mount this same hook app-wide (see
  // pages/company/branding.ts).
  useCompanyBranding();

  const tabParam = params.get('tab') as TabValue | null;
  const tab: TabValue = TABS.some((t) => t.value === tabParam) ? (tabParam as TabValue) : 'profile';
  const setTab = (v: string) => setParams(v === 'profile' ? {} : { tab: v }, { replace: true });

  if (isSystemView || !activeCompany) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Company Setup</h1>
          <p className="text-sm text-muted-foreground">
            Per-company profile, branding, modules, policies and custom fields.
          </p>
        </div>
        <Card className="rounded-xl">
          <CardContent className="space-y-4 p-6">
            <p className="text-sm text-muted-foreground">
              No company is active — you are in the SuperAdmin system view. Enter a company to customize it:
            </p>
            <div className="flex flex-wrap gap-2">
              {companies.map((c) => (
                <Button key={c.id} variant="outline" onClick={() => setActiveCompany(c.id)}>
                  <span
                    className="mr-2 flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold text-white"
                    style={{ backgroundColor: c.branding.accentColor }}
                  >
                    {c.branding.logoText.slice(0, 2)}
                  </span>
                  {c.name}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              New companies are provisioned from the{' '}
              <Link to="/superadmin" className="font-medium text-amber-700 hover:underline underline-offset-4">
                SuperAdmin console
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className="flex h-10 w-10 items-center justify-center rounded-xl text-sm font-bold text-white"
          style={{ backgroundColor: activeCompany.branding.accentColor }}
        >
          {activeCompany.branding.logoText.slice(0, 3).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight">Company Setup</h1>
          <p className="text-sm text-muted-foreground">
            Customization for <span className="font-medium text-foreground">{activeCompany.name}</span> — changes are
            scoped to this company only and recorded in its audit log.
          </p>
        </div>
        <div className="flex gap-1.5">
          <Badge variant="outline" className={cn('capitalize', PLAN_CLS[activeCompany.plan] ?? '')}>
            {activeCompany.plan} plan
          </Badge>
          <Badge variant="outline" className="capitalize">
            {activeCompany.status}
          </Badge>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="gap-6">
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
          {TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value} className="flex-none">
              <t.icon className="h-4 w-4" />
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="profile">
          <ProfileSection />
        </TabsContent>
        <TabsContent value="branding">
          <BrandingSection />
        </TabsContent>
        <TabsContent value="modules">
          <ModulesSection />
        </TabsContent>
        <TabsContent value="policy">
          <PolicySection />
        </TabsContent>
        <TabsContent value="fields">
          <CustomFieldsSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
