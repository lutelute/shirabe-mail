interface BadgeProps {
  count: number;
  variant?: 'default' | 'warning' | 'success';
}

export default function Badge({ count, variant = 'default' }: BadgeProps) {
  if (count <= 0) return null;

  const colors = {
    default: 'bg-blue-500 text-white',
    warning: 'bg-yellow-500 text-black',
    success: 'bg-green-500 text-white',
  };

  return (
    <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${colors[variant]}`}>
      {count > 99 ? '99+' : count}
    </span>
  );
}
