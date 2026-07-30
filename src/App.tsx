import { NavLink, Outlet } from 'react-router-dom';
// Imported rather than referenced by path: at 776 bytes it falls under Vite's
// inline limit and becomes a data URI, so the logo survives any base path —
// including the single-file build, which has no sibling files at all.
import logoUrl from './assets/logo.svg';
import {
  IconCards,
  IconFolder,
  IconGrid,
  IconSettings,
  IconUsers,
} from './components/icons';

const NAV = [
  { to: '/', label: '卡片', Icon: IconCards, end: true },
  { to: '/groups', label: '團體', Icon: IconUsers, end: false },
  { to: '/folders', label: '收藏夾', Icon: IconFolder, end: false },
  { to: '/sets', label: '套卡', Icon: IconGrid, end: false },
  { to: '/settings', label: '設定', Icon: IconSettings, end: false },
];

export default function App() {
  return (
    <div className="min-h-dvh md:flex">
      {/* Tablet / desktop: persistent sidebar */}
      <aside className="safe-top sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-border bg-surface px-3 py-5 md:flex">
        <div className="mb-6 flex items-center gap-2 px-2">
          <img src={logoUrl} alt="" className="h-7 w-7" />
          <span className="font-semibold">小卡櫃</span>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV.map(({ to, label, Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
                  isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-text'
                }`
              }
            >
              <Icon />
              {label}
            </NavLink>
          ))}
        </nav>
        <p className="mt-auto px-3 text-[11px] leading-relaxed text-muted">
          資料只存在這台裝置上。
          <br />
          記得定期到設定匯出備份。
        </p>
      </aside>

      <main className="safe-top min-w-0 flex-1 px-4 pt-5 pb-28 md:px-8 md:pb-10">
        <div className="mx-auto w-full max-w-6xl">
          <Outlet />
        </div>
      </main>

      {/* Phone: bottom tab bar */}
      <nav className="safe-bottom fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-surface/95 backdrop-blur md:hidden">
        {NAV.map(({ to, label, Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] transition-colors ${
                isActive ? 'text-accent' : 'text-muted'
              }`
            }
          >
            <Icon />
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
