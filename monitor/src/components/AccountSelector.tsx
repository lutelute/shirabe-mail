import type { AccountConfig } from '../types';

interface AccountSelectorProps {
  accounts: AccountConfig[];
  selected: string;
  onSelect: (email: string) => void;
}

export default function AccountSelector({
  accounts,
  selected,
  onSelect,
}: AccountSelectorProps) {
  return (
    <div className="flex gap-1 overflow-x-auto">
      <button
        onClick={() => onSelect('all')}
        className={`px-3 py-1 text-xs rounded whitespace-nowrap transition-colors ${
          selected === 'all'
            ? 'bg-blue-500 text-white'
            : 'bg-surface-700 text-surface-400 hover:text-white'
        }`}
      >
        全て
      </button>
      {accounts.map((account) => (
        <button
          key={account.email}
          onClick={() => onSelect(account.email)}
          className={`px-3 py-1 text-xs rounded whitespace-nowrap transition-colors ${
            selected === account.email
              ? 'bg-blue-500 text-white'
              : 'bg-surface-700 text-surface-400 hover:text-white'
          }`}
        >
          {account.label || account.email}
        </button>
      ))}
    </div>
  );
}
