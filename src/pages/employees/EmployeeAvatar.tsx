import { avatarTone, initialsOf, cn } from '@/lib/utils';

interface EmployeeAvatarProps {
  name: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZES = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-16 w-16 text-lg',
} as const;

/** Initials avatar — deterministic warm tint from the employee's name. */
export function EmployeeAvatar({ name, size = 'md', className }: EmployeeAvatarProps) {
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full font-semibold',
        SIZES[size],
        avatarTone(name),
        className,
      )}
      aria-hidden
    >
      {initialsOf(name)}
    </div>
  );
}
