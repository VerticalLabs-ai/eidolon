import { useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { Tabs } from '@/components/ui/Tabs';
import { AnalyticsDashboard } from '@/pages/AnalyticsDashboard';
import { AgentPerformance } from '@/pages/AgentPerformance';
import { CostDashboard } from '@/components/analytics/CostDashboard';
import type { Tab } from '@/components/ui/Tabs';

const tabs: Tab[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'performance', label: 'Agent Performance' },
  { id: 'costs', label: 'Costs' },
];

export function Analytics() {
  const [activeTab, setActiveTab] = useState('overview');

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      <div className="shrink-0 bg-surface">
        <div className="flex items-center gap-3 px-5 pt-4 pb-0">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15">
            <BarChart3 className="h-4 w-4 text-accent" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-text-primary font-display tracking-wide">
              Analytics
            </h1>
          </div>
        </div>
        <Tabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto">
        {activeTab === 'overview' && <AnalyticsDashboard />}
        {activeTab === 'performance' && <AgentPerformance />}
        {activeTab === 'costs' && <CostDashboard />}
      </div>
    </div>
  );
}
