/**
 * /superadmin — the SYSTEM SuperAdmin console.
 *
 * Renders only for the cross-company SuperAdmin session (useAuth().isSuperAdmin);
 * any other role sees a styled restricted notice. Five areas, organised as tabs:
 *   Overview   — tenant stats, estimated MRR, headcount & plan charts
 *   Companies  — directory with Enter / Edit / Suspend / Reactivate + create wizard
 *   Activity   — merged cross-tenant audit trail (latest 50)
 *   System     — demo-data reseed, global holidays note, plan matrix
 */
import { useNavigate } from 'react-router-dom';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/lib/authContext';
import { useTenant } from '@/lib/tenantContext';
import { Button } from '@/components/ui/button';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import OverviewSection from './OverviewSection';
import CompaniesSection from './CompaniesSection';
import ActivitySection from './ActivitySection';
import SystemSection from './SystemSection';

/** Styled notice for non-SuperAdmin sessions (direct URL access). */
function RestrictedNotice() {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <Card className="w-full max-w-md rounded-xl border-dashed">
        <CardHeader className="items-center text-center">
          <div className="rounded-full bg-red-100 p-3 dark:bg-red-950">
            <ShieldAlert className="h-6 w-6 text-red-600 dark:text-red-400" />
          </div>
          <CardTitle>Restricted area</CardTitle>
          <CardDescription>
            The Super Admin console is only available to the system SuperAdmin account.
            Your session does not have cross-company privileges.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <Button variant="outline" onClick={() => navigate('/')}>
            Back to dashboard
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export default function SuperAdminPage() {
  const { isSuperAdmin } = useAuth();
  const { companies } = useTenant();

  if (!isSuperAdmin) return <RestrictedNotice />;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <ShieldCheck className="h-6 w-6 text-amber-600" />
          Super Admin
        </h1>
        <p className="text-sm text-muted-foreground">
          System console — {companies.length} tenant{companies.length === 1 ? '' : 's'} under
          management. Monitor usage, onboard companies and maintain demo data.
        </p>
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="grid w-full grid-cols-4 sm:inline-flex sm:w-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="companies">Companies</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <OverviewSection />
        </TabsContent>
        <TabsContent value="companies" className="mt-6">
          <CompaniesSection />
        </TabsContent>
        <TabsContent value="activity" className="mt-6">
          <ActivitySection />
        </TabsContent>
        <TabsContent value="system" className="mt-6">
          <SystemSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
