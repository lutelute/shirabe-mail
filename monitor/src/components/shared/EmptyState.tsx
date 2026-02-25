import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  children?: ReactNode;
}

export default function EmptyState({ icon, title, description, children }: EmptyStateProps) {
  return (
    <div className="flex-1 flex items-center justify-center h-full">
      <div className="text-center">
        {icon && (
          <div className="mb-3">{icon}</div>
        )}
        <p className="text-surface-400 text-sm">{title}</p>
        {description && (
          <p className="text-surface-500 text-xs mt-1">{description}</p>
        )}
        {children}
      </div>
    </div>
  );
}
