/**
 * Company assets tab — issue / return tracking. Outstanding (unreturned)
 * assets feed the offboarding clearance checklist when the employee exits.
 */
import { useState } from 'react';
import { Laptop, Pencil, Plus, Undo2 } from 'lucide-react';
import {
  removeAsset,
  returnAsset,
  saveAsset,
  todayISO,
  type AssetRecord,
} from '@/lib/employeeRecords';
import { cn, fmtDate } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { EmptyBlock, Field, RemoveButton, SectionCard, type TabProps } from './shared';

const CONDITIONS = ['New', 'Good', 'Fair', 'Poor'];

export default function AssetsTab({ employee, file, readOnly, actorName }: TabProps) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AssetRecord | null>(null);
  const [form, setForm] = useState({ item: '', serialNo: '', issuedAt: todayISO(), condition: 'Good' });

  const assets = [...(file?.assets ?? [])].sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
  const outstanding = assets.filter((a) => !a.returnedAt);

  const openAdd = () => {
    setEditing(null);
    setForm({ item: '', serialNo: '', issuedAt: todayISO(), condition: 'Good' });
    setOpen(true);
  };
  const openEdit = (a: AssetRecord) => {
    setEditing(a);
    setForm({ item: a.item, serialNo: a.serialNo ?? '', issuedAt: a.issuedAt, condition: a.condition });
    setOpen(true);
  };

  const submit = () => {
    if (!form.item.trim() || !form.issuedAt) return;
    saveAsset(
      employee.id,
      {
        id: editing?.id,
        item: form.item.trim(),
        serialNo: form.serialNo.trim() || undefined,
        issuedAt: form.issuedAt,
        condition: form.condition,
        returnedAt: editing?.returnedAt,
      },
      actorName,
    );
    setOpen(false);
  };

  if (assets.length === 0 && readOnly) {
    return (
      <EmptyBlock
        icon={Laptop}
        title="No assets issued"
        description="Laptops, phones and access cards issued to this employee will appear here."
      />
    );
  }

  return (
    <SectionCard
      title="Company assets"
      icon={Laptop}
      description="Issued equipment — unreturned items roll into offboarding clearance."
      actions={
        !readOnly && (
          <Button size="sm" variant="outline" onClick={openAdd}>
            <Plus className="mr-1.5 h-4 w-4" /> Issue asset
          </Button>
        )
      }
    >
      {assets.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Nothing issued yet — record laptops, phones, access cards and keys here.
        </p>
      ) : (
        <>
          <p className="mb-3 text-xs text-muted-foreground">
            {outstanding.length} outstanding · {assets.length - outstanding.length} returned
          </p>
          <ul className="divide-y divide-border/60">
            {assets.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {a.item}
                    <Badge
                      variant="outline"
                      className={cn(
                        'border-transparent',
                        a.returnedAt
                          ? 'bg-stone-100 text-stone-600'
                          : 'bg-amber-100 text-amber-800',
                      )}
                    >
                      {a.returnedAt ? `Returned ${fmtDate(a.returnedAt)}` : 'In custody'}
                    </Badge>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Issued {fmtDate(a.issuedAt)} · condition: {a.condition}
                    {a.serialNo ? ` · S/N ${a.serialNo}` : ''}
                  </p>
                </div>
                {!readOnly && (
                  <div className="flex shrink-0 items-center">
                    {!a.returnedAt && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="mr-1 h-8 text-xs"
                        onClick={() => returnAsset(employee.id, a.id, a.item, actorName)}
                      >
                        <Undo2 className="mr-1 h-3.5 w-3.5" /> Return
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground"
                      onClick={() => openEdit(a)}
                      aria-label={`Edit ${a.item}`}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <RemoveButton
                      label={a.item}
                      onConfirm={() => removeAsset(employee.id, a.id, a.item, actorName)}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit asset' : 'Issue asset'}</DialogTitle>
            <DialogDescription>
              Track custody — anything still “In custody” at exit joins the clearance checklist.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Item *">
              <Input
                placeholder="MacBook Pro 14″"
                value={form.item}
                onChange={(e) => setForm({ ...form, item: e.target.value })}
              />
            </Field>
            <Field label="Serial no.">
              <Input value={form.serialNo} onChange={(e) => setForm({ ...form, serialNo: e.target.value })} />
            </Field>
            <Field label="Issued on *">
              <Input
                type="date"
                value={form.issuedAt}
                onChange={(e) => setForm({ ...form, issuedAt: e.target.value })}
              />
            </Field>
            <Field label="Condition">
              <Select value={form.condition} onValueChange={(v) => setForm({ ...form, condition: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONDITIONS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-amber-600 text-white hover:bg-amber-700"
              disabled={!form.item.trim() || !form.issuedAt}
              onClick={submit}
            >
              {editing ? 'Save changes' : 'Issue asset'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
