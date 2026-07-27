/**
 * PositionDialog — PositionForm inside a shadcn Dialog (used by /org).
 */
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import PositionForm, { type PositionFormProps } from './PositionForm';
import { type PositionFormValues } from './positionFormShared';

export interface PositionDialogProps extends Omit<PositionFormProps, 'onSubmit' | 'onCancel'> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: PositionFormValues) => void;
  title: string;
  description?: string;
}

export default function PositionDialog({
  open,
  onOpenChange,
  onSubmit,
  title,
  description,
  ...formProps
}: PositionDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {open && (
          <PositionForm
            {...formProps}
            onSubmit={(values) => {
              onSubmit(values);
              onOpenChange(false);
            }}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
