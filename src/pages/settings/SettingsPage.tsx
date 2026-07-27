/**
 * Settings & admin (M9) — /settings.
 * Eight sections in tabs: company profile, organization, locations &
 * geofence, payroll, leave policy, users & roles, audit log, data management.
 *
 * MULTI-TENANT: deep per-company customization (branding, module toggles,
 * work & payroll policy, custom employee fields) now lives in Company Setup
 * (/company) — the banner below deep-links there. The sections here remain
 * the working editors for the tenant-scoped settings singleton and docs.
 */
import { Link } from 'react-router-dom';
import {
  Building2, CalendarClock, CalendarHeart, DatabaseBackup, MapPin, Network, ScrollText, ShieldCheck,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import AuditSection from './sections/AuditSection';
import CompanySection from './sections/CompanySection';
import DataSection from './sections/DataSection';
import LeavePolicySection from './sections/LeavePolicySection';
import LocationsSection from './sections/LocationsSection';
import OrgSection from './sections/OrgSection';
import PayrollSection from './sections/PayrollSection';
import UsersSection from './sections/UsersSection';

const SECTIONS = [
  { value: 'company', label: 'Company', icon: Building2 },
  { value: 'org', label: 'Organization', icon: Network },
  { value: 'locations', label: 'Locations', icon: MapPin },
  { value: 'payroll', label: 'Payroll', icon: CalendarClock },
  { value: 'leave', label: 'Leave Policy', icon: CalendarHeart },
  { value: 'users', label: 'Users & Roles', icon: ShieldCheck },
  { value: 'audit', label: 'Audit Log', icon: ScrollText },
  { value: 'data', label: 'Data', icon: DatabaseBackup },
] as const;

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Company profile, organization structure, policies and admin tools. Changes are saved to the local
          demo dataset and recorded in the audit log.
        </p>
      </div>

      <Alert>
        <Building2 className="h-4 w-4" />
        <AlertTitle>Per-company customization moved to Company Setup</AlertTitle>
        <AlertDescription>
          Branding, module toggles, work &amp; payroll policy and custom employee fields are now managed per company
          in{' '}
          <Link to="/company" className="font-medium text-amber-700 hover:underline underline-offset-4">
            Company Setup
          </Link>
          . Claim policy, payroll cut-off and leave top-ups saved there are mirrored here so everything stays in sync.
        </AlertDescription>
      </Alert>

      <Tabs defaultValue="company" className="gap-6">
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1">
          {SECTIONS.map((s) => (
            <TabsTrigger key={s.value} value={s.value} className="flex-none">
              <s.icon className="h-4 w-4" />
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="company">
          <CompanySection />
        </TabsContent>
        <TabsContent value="org">
          <OrgSection />
        </TabsContent>
        <TabsContent value="locations">
          <LocationsSection />
        </TabsContent>
        <TabsContent value="payroll">
          <PayrollSection />
        </TabsContent>
        <TabsContent value="leave">
          <LeavePolicySection />
        </TabsContent>
        <TabsContent value="users">
          <UsersSection />
        </TabsContent>
        <TabsContent value="audit">
          <AuditSection />
        </TabsContent>
        <TabsContent value="data">
          <DataSection />
        </TabsContent>
      </Tabs>
    </div>
  );
}
