import { useState } from "react";
import { useParams } from "react-router-dom";
import {
  Trophy,
  TrendingUp,
  TrendingDown,
  Minus,
  Star,
  Zap,
  DollarSign,
  Activity,
  Send,
  ChevronRight,
  BarChart3,
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  useCompanyRankings,
  useCompanyEvaluations,
  useAgentPerformance,
  useAgents,
  useCreateManualEvaluation,
} from "@/lib/hooks";
import type { AgentRanking, AgentEvaluation } from "@/lib/api";

// ---------------------------------------------------------------------------
// SVG Line Chart -- renders score trend over last N evaluations
// ---------------------------------------------------------------------------

function TrendChart({
  evaluations,
  height = 140,
}: {
  evaluations: AgentEvaluation[];
  height?: number;
}) {
  // Use last 10, reversed to oldest-first
  const data = evaluations
    .slice(0, 10)
    .reverse()
    .map((e) => e.overallScore ?? 0);

  if (data.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-text-secondary text-sm"
        style={{ height }}
      >
        Need at least 2 evaluations for trend
      </div>
    );
  }

  const padding = 8;
  const w = 300;
  const h = height;
  const chartW = w - padding * 2;
  const chartH = h - padding * 2 - 20;
  const max = Math.max(...data, 100);
  const min = Math.min(...data, 0);
  const range = max - min || 1;

  const points = data.map((v, i) => ({
    x: padding + (i / (data.length - 1)) * chartW,
    y: padding + 10 + chartH - ((v - min) / range) * chartH,
  }));

  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`)
    .join(" ");

  // Area fill
  const areaD = `${pathD} L ${points[points.length - 1].x} ${h - padding} L ${points[0].x} ${h - padding} Z`;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height }}>
      <defs>
        <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#F0B429" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#F0B429" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Grid lines */}
      {[0, 25, 50, 75, 100].map((v) => {
        const y = padding + 10 + chartH - ((v - min) / range) * chartH;
        return (
          <g key={v}>
            <line
              x1={padding}
              y1={y}
              x2={w - padding}
              y2={y}
              stroke="rgba(255,255,255,0.04)"
              strokeDasharray="2,4"
            />
            <text
              x={padding - 2}
              y={y + 1}
              textAnchor="end"
              className="fill-text-secondary"
              fontSize="7"
            >
              {v}
            </text>
          </g>
        );
      })}
      {/* Area */}
      <path d={areaD} fill="url(#trend-fill)" />
      {/* Line */}
      <path d={pathD} fill="none" stroke="#F0B429" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {/* Dots */}
      {points.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r="3"
          fill="#0F0F12"
          stroke="#F0B429"
          strokeWidth="1.5"
        >
          <title>Score: {data[i]}</title>
        </circle>
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Score Badge -- displays a numeric score with contextual color
// ---------------------------------------------------------------------------

function ScoreBadge({ score, size = "md" }: { score: number | null; size?: "sm" | "md" | "lg" }) {
  if (score == null) return <span className="text-text-secondary">--</span>;

  let color = "text-red-400";
  if (score >= 80) color = "text-emerald-400";
  else if (score >= 60) color = "text-amber-400";
  else if (score >= 40) color = "text-orange-400";

  const sizeClass = {
    sm: "text-sm",
    md: "text-xl",
    lg: "text-3xl",
  }[size];

  return <span className={`${color} ${sizeClass} font-display font-bold tabular-nums`}>{score}</span>;
}

// ---------------------------------------------------------------------------
// Score Bar -- horizontal bar visualization
// ---------------------------------------------------------------------------

function ScoreBar({ label, score, icon }: { label: string; score: number; icon: React.ReactNode }) {
  let barColor = "bg-red-400/60";
  if (score >= 80) barColor = "bg-emerald-400/60";
  else if (score >= 60) barColor = "bg-amber-400/60";
  else if (score >= 40) barColor = "bg-orange-400/60";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2 text-text-secondary">
          {icon}
          {label}
        </div>
        <ScoreBadge score={score} size="sm" />
      </div>
      <div className="h-2 rounded-full bg-white/[0.06] overflow-hidden">
        <div
          className={`h-full rounded-full ${barColor} transition-all duration-700 ease-out`}
          style={{ width: `${score}%` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leaderboard Row
// ---------------------------------------------------------------------------

function LeaderboardRow({
  ranking,
  rank,
  isSelected,
  onSelect,
}: {
  ranking: AgentRanking;
  rank: number;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const medalColors: Record<number, string> = {
    1: "text-amber-400",
    2: "text-zinc-400",
    3: "text-amber-700",
  };

  return (
    <button
      onClick={onSelect}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg transition-all duration-200 cursor-pointer text-left ${
        isSelected
          ? "bg-accent/[0.08] border border-accent/20"
          : "hover:bg-white/[0.04] border border-transparent"
      }`}
    >
      <div className="w-8 text-center">
        {rank <= 3 ? (
          <Trophy className={`h-4 w-4 mx-auto ${medalColors[rank]}`} />
        ) : (
          <span className="text-sm text-text-secondary font-display">{rank}</span>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text-primary truncate">{ranking.agentName}</p>
        <p className="text-xs text-text-secondary capitalize">{ranking.role}</p>
      </div>
      <div className="text-right">
        <ScoreBadge score={ranking.averageScore} size="sm" />
        <p className="text-[10px] text-text-secondary mt-0.5">
          {ranking.totalTasks} eval{ranking.totalTasks !== 1 ? "s" : ""}
        </p>
      </div>
      <ChevronRight className={`h-3.5 w-3.5 text-text-secondary transition-colors ${isSelected ? "text-accent" : ""}`} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Manual Evaluation Form
// ---------------------------------------------------------------------------

function EvaluationForm({
  companyId,
  agents,
}: {
  companyId: string;
  agents: { id: string; name: string }[];
}) {
  const [selectedAgent, setSelectedAgent] = useState("");
  const [score, setScore] = useState(7);
  const [feedback, setFeedback] = useState("");
  const createEval = useCreateManualEvaluation(companyId);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAgent || !feedback.trim()) return;

    createEval.mutate(
      { agentId: selectedAgent, data: { qualityScore: score, feedback: feedback.trim() } },
      {
        onSuccess: () => {
          setFeedback("");
          setScore(7);
        },
      },
    );
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Agent selector */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wider font-display">
          Agent
        </label>
        <select
          value={selectedAgent}
          onChange={(e) => setSelectedAgent(e.target.value)}
          className="w-full rounded-lg bg-white/[0.04] border border-white/[0.08] px-3 py-2 text-sm text-text-primary focus:border-accent/40 focus:outline-none transition-colors"
        >
          <option value="">Select agent...</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </div>

      {/* Score slider */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wider font-display">
          Quality Score
        </label>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={1}
            max={10}
            value={score}
            onChange={(e) => setScore(parseInt(e.target.value, 10))}
            className="flex-1 h-1.5 rounded-full appearance-none bg-white/[0.08] accent-amber-500 cursor-pointer"
          />
          <span className="text-lg font-display font-bold text-accent tabular-nums w-8 text-right">
            {score}
          </span>
        </div>
        <div className="flex justify-between text-[10px] text-text-secondary mt-1 px-0.5">
          <span>Poor</span>
          <span>Average</span>
          <span>Excellent</span>
        </div>
      </div>

      {/* Feedback */}
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wider font-display">
          Feedback
        </label>
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={3}
          placeholder="Describe the agent's performance..."
          className="w-full rounded-lg bg-white/[0.04] border border-white/[0.08] px-3 py-2 text-sm text-text-primary placeholder-text-secondary/50 focus:border-accent/40 focus:outline-none transition-colors resize-none"
        />
      </div>

      {/* Submit */}
      <button
        type="submit"
        disabled={!selectedAgent || !feedback.trim() || createEval.isPending}
        className="w-full flex items-center justify-center gap-2 rounded-lg bg-accent/15 hover:bg-accent/25 text-accent px-4 py-2.5 text-sm font-medium transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      >
        <Send className="h-3.5 w-3.5" />
        {createEval.isPending ? "Submitting..." : "Submit Evaluation"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export function AgentPerformance() {
  const { companyId } = useParams();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const { data: rankings, isLoading: rankingsLoading } = useCompanyRankings(companyId);
  const { data: evaluations, isLoading: evalsLoading } = useCompanyEvaluations(companyId);
  const { data: agentsList } = useAgents(companyId);
  const { data: performance } = useAgentPerformance(companyId, selectedAgentId ?? undefined);

  const isLoading = rankingsLoading || evalsLoading;

  // Company-wide averages
  const companyAvg = rankings && rankings.length > 0
    ? Math.round(rankings.reduce((s, r) => s + r.averageScore, 0) / rankings.length)
    : 0;

  const totalEvals = evaluations?.length ?? 0;
  const totalAgentsRanked = rankings?.length ?? 0;

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-bold text-text-primary font-display tracking-wide">
          Performance
        </h1>
        <p className="text-sm text-text-secondary mt-1">
          Agent evaluation scores, rankings, and performance trends
        </p>
      </div>

      {/* Company-wide stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10">
              <BarChart3 className="h-5 w-5 text-accent" />
            </div>
            <div>
              <p className="text-xs text-text-secondary uppercase tracking-wider font-display">Company Average</p>
              <p className="text-2xl font-bold text-text-primary font-display tabular-nums">{companyAvg}</p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10">
              <Activity className="h-5 w-5 text-emerald-400" />
            </div>
            <div>
              <p className="text-xs text-text-secondary uppercase tracking-wider font-display">Total Evaluations</p>
              <p className="text-2xl font-bold text-text-primary font-display tabular-nums">{totalEvals}</p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10">
              <Trophy className="h-5 w-5 text-blue-400" />
            </div>
            <div>
              <p className="text-xs text-text-secondary uppercase tracking-wider font-display">Agents Ranked</p>
              <p className="text-2xl font-bold text-text-primary font-display tabular-nums">{totalAgentsRanked}</p>
            </div>
          </div>
        </Card>
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* LEFT: Leaderboard */}
        <div className="lg:col-span-1 space-y-6">
          <Card
            header={
              <div className="flex items-center gap-2">
                <Trophy className="h-4 w-4 text-accent" />
                Agent Leaderboard
              </div>
            }
            padding={false}
          >
            <div className="p-2 space-y-1 max-h-[500px] overflow-y-auto">
              {!rankings || rankings.length === 0 ? (
                <div className="py-8">
                  <EmptyState
                    icon={<Trophy className="h-5 w-5" />}
                    title="No rankings yet"
                    description="Evaluate agents to see them ranked here"
                  />
                </div>
              ) : (
                rankings.map((r, i) => (
                  <LeaderboardRow
                    key={r.agentId}
                    ranking={r}
                    rank={i + 1}
                    isSelected={selectedAgentId === r.agentId}
                    onSelect={() => setSelectedAgentId(r.agentId)}
                  />
                ))
              )}
            </div>
          </Card>

          {/* Manual Evaluation Form */}
          <Card
            header={
              <div className="flex items-center gap-2">
                <Star className="h-4 w-4 text-accent" />
                Manual Evaluation
              </div>
            }
          >
            <EvaluationForm
              companyId={companyId!}
              agents={(agentsList ?? []).map((a) => ({ id: a.id, name: a.name }))}
            />
          </Card>
        </div>

        {/* RIGHT: Detail panels */}
        <div className="lg:col-span-2 space-y-6">
          {selectedAgentId && performance ? (
            <>
              {/* Score Breakdown */}
              <Card
                header={
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Activity className="h-4 w-4 text-accent" />
                      Score Breakdown
                    </div>
                    <div className="flex items-center gap-2">
                      {performance.trend === "improving" && (
                        <span className="flex items-center gap-1 text-xs text-emerald-400">
                          <TrendingUp className="h-3.5 w-3.5" /> Improving
                        </span>
                      )}
                      {performance.trend === "declining" && (
                        <span className="flex items-center gap-1 text-xs text-red-400">
                          <TrendingDown className="h-3.5 w-3.5" /> Declining
                        </span>
                      )}
                      {performance.trend === "stable" && (
                        <span className="flex items-center gap-1 text-xs text-text-secondary">
                          <Minus className="h-3.5 w-3.5" /> Stable
                        </span>
                      )}
                    </div>
                  </div>
                }
              >
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  {/* Overall Score */}
                  <div className="flex flex-col items-center justify-center py-4">
                    <p className="text-xs text-text-secondary uppercase tracking-wider font-display mb-2">
                      Overall Score
                    </p>
                    <div className="relative h-28 w-28">
                      <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90">
                        <circle
                          cx="50"
                          cy="50"
                          r="42"
                          fill="none"
                          stroke="rgba(255,255,255,0.06)"
                          strokeWidth="8"
                        />
                        <circle
                          cx="50"
                          cy="50"
                          r="42"
                          fill="none"
                          stroke="#F0B429"
                          strokeWidth="8"
                          strokeLinecap="round"
                          strokeDasharray={`${(performance.averageScores.overall / 100) * 264} 264`}
                          className="transition-all duration-1000 ease-out"
                        />
                      </svg>
                      <div className="absolute inset-0 flex items-center justify-center">
                        <ScoreBadge score={performance.averageScores.overall} size="lg" />
                      </div>
                    </div>
                    <p className="text-xs text-text-secondary mt-2">
                      {performance.totalEvaluations} evaluation{performance.totalEvaluations !== 1 ? "s" : ""}
                    </p>
                  </div>

                  {/* Individual scores */}
                  <div className="space-y-4 py-2">
                    <ScoreBar
                      label="Quality"
                      score={performance.averageScores.quality}
                      icon={<Star className="h-3.5 w-3.5" />}
                    />
                    <ScoreBar
                      label="Speed"
                      score={performance.averageScores.speed}
                      icon={<Zap className="h-3.5 w-3.5" />}
                    />
                    <ScoreBar
                      label="Cost Efficiency"
                      score={performance.averageScores.costEfficiency}
                      icon={<DollarSign className="h-3.5 w-3.5" />}
                    />
                  </div>
                </div>
              </Card>

              {/* Trend Chart */}
              <Card
                header={
                  <div className="flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-accent" />
                    Score Trend
                  </div>
                }
              >
                <TrendChart evaluations={performance.recentEvaluations} />
              </Card>

              {/* Recent Evaluations */}
              <Card
                header={
                  <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-accent" />
                    Recent Evaluations
                  </div>
                }
                padding={false}
              >
                <div className="divide-y divide-white/[0.04]">
                  {performance.recentEvaluations.length === 0 ? (
                    <div className="py-8">
                      <EmptyState
                        icon={<Activity className="h-5 w-5" />}
                        title="No evaluations"
                        description="This agent has not been evaluated yet"
                      />
                    </div>
                  ) : (
                    performance.recentEvaluations.map((ev) => (
                      <div key={ev.id} className="flex items-center gap-4 px-5 py-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span
                              className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
                                ev.evaluator === "human"
                                  ? "bg-blue-500/10 text-blue-400"
                                  : "bg-accent/10 text-accent"
                              }`}
                            >
                              {ev.evaluator}
                            </span>
                            {ev.taskId && (
                              <span className="text-xs text-text-secondary truncate">
                                Task: {ev.taskId.slice(0, 8)}...
                              </span>
                            )}
                          </div>
                          {ev.feedback && (
                            <p className="text-sm text-text-secondary mt-1 line-clamp-1">
                              {ev.feedback}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          {ev.qualityScore != null && (
                            <div className="text-center">
                              <p className="text-[9px] text-text-secondary uppercase font-display">Qual</p>
                              <ScoreBadge score={ev.qualityScore} size="sm" />
                            </div>
                          )}
                          {ev.speedScore != null && (
                            <div className="text-center">
                              <p className="text-[9px] text-text-secondary uppercase font-display">Spd</p>
                              <ScoreBadge score={ev.speedScore} size="sm" />
                            </div>
                          )}
                          {ev.costEfficiencyScore != null && (
                            <div className="text-center">
                              <p className="text-[9px] text-text-secondary uppercase font-display">Cost</p>
                              <ScoreBadge score={ev.costEfficiencyScore} size="sm" />
                            </div>
                          )}
                          <div className="text-center pl-2 border-l border-white/[0.06]">
                            <p className="text-[9px] text-text-secondary uppercase font-display">Overall</p>
                            <ScoreBadge score={ev.overallScore} size="sm" />
                          </div>
                        </div>
                        <div className="text-xs text-text-secondary shrink-0 w-16 text-right">
                          {new Date(ev.createdAt).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </Card>
            </>
          ) : (
            /* No agent selected state */
            <Card className="h-full min-h-[400px] flex items-center justify-center">
              <EmptyState
                icon={<Trophy className="h-5 w-5" />}
                title="Select an agent"
                description={
                  rankings && rankings.length > 0
                    ? "Click an agent in the leaderboard to view their detailed performance breakdown"
                    : "Submit evaluations to start tracking agent performance"
                }
              />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
