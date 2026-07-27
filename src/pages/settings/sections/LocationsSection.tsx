/**
 * Settings → Office locations & geofence: CRUD for office/site locations
 * persisted as `officeLocations` on the company settings singleton — the
 * canonical shape the Attendance module (and lib getOfficeLocations()) reads
 * to validate clock-ins against these geofences.
 */
import { useState, type FormEvent } from 'react';
import { MapPin, Pencil, Plus, Radar, Trash2 } from 'lucide-react';
import { logAudit } from '@/lib/db';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { DEMO_ACTOR, Field, SectionCard, numOr } from '../shared';
import { useSettingsData, type OfficeLocation } from '../store';

interface LocForm {
  name: string;
  address: string;
  lat: string;
  lng: string;
  radiusM: string;
}

const EMPTY_FORM: LocForm = { name: '', address: '', lat: '', lng: '', radiusM: '150' };

/** Soft sanity bounds for Malaysian premises (Peninsular + East Malaysia). */
const MY_LAT = { min: 0.8, max: 7.4 };
const MY_LNG = { min: 99.6, max: 119.3 };

export default function LocationsSection() {
  const { locations, addLocation, updateLocation, removeLocation } = useSettingsData();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<OfficeLocation | null>(null);
  const [deleting, setDeleting] = useState<OfficeLocation | null>(null);
  const [form, setForm] = useState<LocForm>(EMPTY_FORM);

  const openAdd = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };
  const openEdit = (l: OfficeLocation) => {
    setEditing(l);
    setForm({ name: l.name, address: l.address, lat: String(l.lat), lng: String(l.lng), radiusM: String(l.radiusM) });
    setDialogOpen(true);
  };

  // numOr returns NaN for blank input, so cleared lat/lng can never save as
  // a (0, 0) geofence off the coast of Ghana.
  const lat = numOr(form.lat, NaN);
  const lng = numOr(form.lng, NaN);
  const radius = numOr(form.radiusM, NaN);
  const latInvalid = Number.isFinite(lat) && (lat < -90 || lat > 90);
  const lngInvalid = Number.isFinite(lng) && (lng < -180 || lng > 180);
  const outsideMalaysia =
    Number.isFinite(lat) && Number.isFinite(lng) && !latInvalid && !lngInvalid &&
    (lat < MY_LAT.min || lat > MY_LAT.max || lng < MY_LNG.min || lng > MY_LNG.max);
  const valid =
    form.name.trim().length > 0 &&
    form.address.trim().length > 0 &&
    Number.isFinite(lat) && !latInvalid &&
    Number.isFinite(lng) && !lngInvalid &&
    Number.isFinite(radius) && radius >= 10;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const patch = {
      name: form.name.trim(),
      address: form.address.trim(),
      lat: Math.round(lat * 1e6) / 1e6,
      lng: Math.round(lng * 1e6) / 1e6,
      radiusM: Math.round(radius),
    };
    if (editing) {
      updateLocation(editing.id, patch);
      logAudit({ actorName: DEMO_ACTOR, action: 'location.update', entity: 'settings', entityId: editing.id, detail: patch.name });
    } else {
      addLocation(patch);
      logAudit({ actorName: DEMO_ACTOR, action: 'location.create', entity: 'settings', detail: patch.name });
    }
    setDialogOpen(false);
  };

  const confirmDelete = () => {
    if (!deleting) return;
    removeLocation(deleting.id);
    logAudit({ actorName: DEMO_ACTOR, action: 'location.delete', entity: 'settings', entityId: deleting.id, detail: deleting.name });
    setDeleting(null);
  };

  return (
    <div className="space-y-6">
      <Alert>
        <Radar className="h-4 w-4" />
        <AlertTitle>Attendance geofencing — scoped to the active company</AlertTitle>
        <AlertDescription>
          This list is saved on the ACTIVE company&apos;s settings record and read live by the Attendance module: a
          clock-in is accepted when the device position falls within the geofence radius of any location below.
          Remote / off-site work is flagged when no geofence matches. This remains the canonical geofence editor —
          Company Setup → Work &amp; Payroll Policy links here.
        </AlertDescription>
      </Alert>

      <SectionCard
        icon={MapPin}
        title="Office & site locations"
        description={`${locations.length} geofenced location${locations.length === 1 ? '' : 's'} configured.`}
        action={
          <Button size="sm" onClick={openAdd}>
            <Plus className="mr-1.5 h-4 w-4" /> Add location
          </Button>
        }
      >
        {/* Map placeholder */}
        <div className="flex aspect-[2/1] flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/40 text-center sm:aspect-[3/1]">
          <MapPin className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium text-muted-foreground">Map preview</p>
          <p className="max-w-sm px-4 text-xs text-muted-foreground">
            Placeholder — plug a map provider in here. Geofence coordinates and radii are managed in the list below.
          </p>
        </div>

        {locations.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No locations configured — geofence validation is off and every clock-in is recorded without an
            inside/outside verdict. Add your first office or site to enable geofenced clock-ins.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {locations.map((l) => (
              <div key={l.id} className="flex flex-col gap-2 rounded-xl border p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{l.name}</p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{l.address}</p>
                  </div>
                  <Badge variant="secondary" className="shrink-0">
                    {l.radiusM} m
                  </Badge>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                    {l.lat.toFixed(4)}, {l.lng.toFixed(4)}
                  </code>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" aria-label={`Edit ${l.name}`} onClick={() => openEdit(l)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={`Delete ${l.name}`} onClick={() => setDeleting(l)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent>
            <form onSubmit={onSubmit} className="space-y-4">
              <DialogHeader>
                <DialogTitle>{editing ? 'Edit location' : 'Add location'}</DialogTitle>
                <DialogDescription>Coordinates in decimal degrees (WGS 84); radius in metres.</DialogDescription>
              </DialogHeader>
              <Field label="Location name">
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. HQ — Menara ASM" />
              </Field>
              <Field label="Address">
                <Textarea rows={2} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Latitude" hint="-90 to 90, required">
                  <Input type="number" step="any" value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} placeholder="3.1516" />
                </Field>
                <Field label="Longitude" hint="-180 to 180, required">
                  <Input type="number" step="any" value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} placeholder="101.7036" />
                </Field>
              </div>
              <Field label="Geofence radius (metres)" hint="Minimum 10 m; 100–300 m works well for office towers.">
                <Input type="number" min={10} step={10} value={form.radiusM} onChange={(e) => setForm({ ...form, radiusM: e.target.value })} />
              </Field>
              {latInvalid ? <p className="text-xs text-destructive">Latitude must be between -90 and 90.</p> : null}
              {lngInvalid ? <p className="text-xs text-destructive">Longitude must be between -180 and 180.</p> : null}
              {outsideMalaysia ? (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  These coordinates fall outside Malaysia — double-check before saving an overseas site.
                </p>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!valid}>
                  {editing ? 'Save changes' : 'Add location'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                Clock-ins near this site will no longer match a geofence and may be flagged as off-site.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={confirmDelete}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SectionCard>
    </div>
  );
}
