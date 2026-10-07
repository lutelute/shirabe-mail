import { useState, useEffect } from 'react';
import { useAppContext } from './context/AppContext';
import type { ViewType } from './types';
import Sidebar from './components/layout/Sidebar';
import HeaderBar from './components/layout/HeaderBar';
import ErrorBoundary from './components/shared/ErrorBoundary';
import MailView from './views/MailView';
import CalendarView from './views/CalendarView';
import TaskView from './views/TaskView';
import SearchView from './views/SearchView';
import TriageView from './views/TriageView';
import TodoView from './views/TodoView';
import ProjectView from './views/ProjectView';
import AuditView from './views/AuditView';
import ProposalView from './views/ProposalView';
import TerminalView from './views/TerminalView';
import JunkView from './views/JunkView';
import SettingsView from './views/SettingsView';
import OutlookView from './views/OutlookView';
import TodayView from './views/TodayView';
import SetupWizard from './components/SetupWizard';

export default function App() {
  const [activeView, setActiveView] = useState<ViewType>('today');
  const { settings, isFirstRun } = useAppContext();
  const [showWizard, setShowWizard] = useState(false);

  useEffect(() => {
    if (isFirstRun) setShowWizard(true);
  }, [isFirstRun]);

  // テーマ(paper が既定)
  useEffect(() => {
    const body = document.body;
    body.classList.remove('theme-paper');
    if (settings.theme === 'paper') body.classList.add('theme-paper');
  }, [settings.theme]);

  // ⌘, で設定、⌘1 で今日、⌘2 で見通し、⌘3 でターミナル
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); setActiveView('settings'); }
      if ((e.metaKey || e.ctrlKey) && e.key === '1') { e.preventDefault(); setActiveView('today'); }
      if ((e.metaKey || e.ctrlKey) && e.key === '2') { e.preventDefault(); setActiveView('shirabe'); }
      if ((e.metaKey || e.ctrlKey) && e.key === '3') { e.preventDefault(); setActiveView('terminal'); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const renderContent = () => {
    switch (activeView) {
      case 'today': return <TodayView onNavigate={setActiveView} />;
      case 'shirabe': return <OutlookView onNavigate={setActiveView} />;
      case 'mail': return <MailView onNavigate={setActiveView} />;
      case 'calendar': return <CalendarView onNavigate={setActiveView} />;
      case 'task': return <TaskView />;
      case 'search': return <SearchView />;
      case 'triage': return <TriageView />;
      case 'todo': return <TodoView />;
      case 'project': return <ProjectView />;
      case 'audit': return <AuditView />;
      case 'proposal': return <ProposalView />;
      case 'terminal':
      case 'chat': return <TerminalView />;
      case 'junk': return <JunkView />;
      case 'settings': return <SettingsView />;
      default: return null;
    }
  };

  return (
    <div className="h-screen bg-paper text-ink flex flex-col overflow-hidden">
      <HeaderBar activeView={activeView} />
      <div className="flex-1 flex overflow-hidden">
        <Sidebar activeView={activeView} onNavigate={setActiveView} />
        <main className="flex-1 overflow-hidden">
          <ErrorBoundary viewName={activeView}>
            {renderContent()}
          </ErrorBoundary>
        </main>
      </div>
      {showWizard && <SetupWizard onComplete={() => setShowWizard(false)} />}
    </div>
  );
}
