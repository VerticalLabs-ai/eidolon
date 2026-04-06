import { useState, useMemo } from "react";
import { useParams } from "react-router-dom";
import { MessageSquare, Send } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useMessages, useSendMessage, useAgents } from "@/lib/hooks";
import { EmptyState } from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import { clsx } from "clsx";
import type { Message } from "@/lib/api";

export function MessageCenter() {
  const { companyId } = useParams();
  const { data: messages, isLoading } = useMessages(companyId);
  const { data: agents } = useAgents(companyId);
  const sendMessage = useSendMessage(companyId!);
  const [selectedThreadId, setSelectedThreadId] = useState<string | undefined>();
  const [newMessage, setNewMessage] = useState("");

  // Build agent name lookup
  const agentNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents ?? []) {
      map.set(a.id, a.name);
    }
    return map;
  }, [agents]);

  // Group messages by threadId
  const threads = useMemo(() => {
    const threadMap = new Map<string, Message[]>();
    for (const msg of messages ?? []) {
      const tid = msg.threadId ?? msg.id;
      if (!threadMap.has(tid)) {
        threadMap.set(tid, []);
      }
      threadMap.get(tid)!.push(msg);
    }
    // Sort threads by most recent message
    const entries = Array.from(threadMap.entries()).map(([id, msgs]) => {
      const sorted = msgs.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      const last = sorted[sorted.length - 1];
      return {
        id,
        messages: sorted,
        lastMessage: last?.content ?? '',
        lastMessageAt: last?.createdAt ?? '',
        messageCount: sorted.length,
        fromAgentId: sorted[0]?.fromAgentId ?? '',
        toAgentId: sorted[0]?.toAgentId ?? '',
      };
    });
    entries.sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
    return entries;
  }, [messages]);

  const selectedThread = threads.find((t) => t.id === selectedThreadId);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !selectedThread) return;
    sendMessage.mutate(
      {
        content: newMessage,
        fromAgentId: selectedThread.fromAgentId,
        toAgentId: selectedThread.toAgentId,
        threadId: selectedThreadId,
      },
      {
        onSuccess: () => setNewMessage(""),
      },
    );
  };

  return (
    <div className="flex h-full">
      {/* Thread list */}
      <div className="w-80 shrink-0 border-r border-white/[0.06] bg-surface overflow-y-auto hidden sm:block">
        <div className="p-5 border-b border-white/[0.06]">
          <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
            Messages
          </h3>
        </div>
        {isLoading ? (
          <div className="space-y-3 p-4">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-16 animate-pulse rounded-xl glass"
              />
            ))}
          </div>
        ) : !threads.length ? (
          <p className="p-5 text-sm text-text-secondary text-center">
            No conversations yet
          </p>
        ) : (
          <div className="p-3 space-y-1">
            {threads.map((thread) => (
              <button
                key={thread.id}
                onClick={() => setSelectedThreadId(thread.id)}
                className={clsx(
                  "w-full text-left rounded-xl px-4 py-3 transition-all duration-200 cursor-pointer",
                  selectedThreadId === thread.id
                    ? "glass border border-neon-cyan/30 shadow-md shadow-neon-cyan/5"
                    : "glass-raised hover:glass-hover",
                )}
              >
                <div className="flex items-center justify-between">
                  <span className={clsx(
                    "text-sm font-medium truncate",
                    selectedThreadId === thread.id ? "text-neon-cyan" : "text-text-primary",
                  )}>
                    {agentNames.get(thread.fromAgentId) ?? 'Agent'} &rarr; {agentNames.get(thread.toAgentId) ?? 'Agent'}
                  </span>
                  <span className="text-[10px] text-text-secondary/70 tabular-nums font-display shrink-0">
                    {thread.lastMessageAt
                      ? formatDistanceToNow(new Date(thread.lastMessageAt), { addSuffix: true })
                      : ''}
                  </span>
                </div>
                <p className="mt-1 text-xs truncate text-text-secondary">
                  {thread.lastMessage}
                </p>
                <span className="text-[10px] text-text-secondary/40 font-display">
                  {thread.messageCount} message{thread.messageCount !== 1 ? 's' : ''}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Message area */}
      <div className="flex flex-1 flex-col bg-surface">
        {!selectedThreadId || !selectedThread ? (
          <EmptyState
            icon={<MessageSquare className="h-6 w-6" />}
            title="Select a conversation"
            description="Choose a thread from the sidebar to view messages."
          />
        ) : (
          <>
            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-6 space-y-5 grid-bg">
              {selectedThread.messages.map((msg) => {
                const senderName = agentNames.get(msg.fromAgentId) ?? 'Unknown Agent';
                return (
                  <div key={msg.id} className="flex gap-4">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neon-cyan/10 text-xs font-semibold text-neon-cyan font-display">
                      {senderName.charAt(0)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary">
                          {senderName}
                        </span>
                        <time className="text-[10px] text-text-secondary/70 tabular-nums font-display">
                          {formatDistanceToNow(new Date(msg.createdAt), {
                            addSuffix: true,
                          })}
                        </time>
                      </div>
                      <div className="mt-1.5 glass-raised rounded-xl px-4 py-3">
                        <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">
                          {msg.content}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Message input */}
            <form
              onSubmit={handleSend}
              className="flex items-center gap-3 border-t border-white/[0.06] p-5"
            >
              <input
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                placeholder="Type a message..."
                className="flex-1 rounded-xl glass px-4 py-3 text-sm text-text-primary placeholder:text-text-secondary/40 outline-none transition-all duration-200 focus:shadow-md focus:shadow-neon-cyan/10 focus:border-neon-cyan/30 border border-transparent"
              />
              <button
                type="submit"
                disabled={!newMessage.trim()}
                className="inline-flex items-center gap-1.5 rounded-md h-8 px-3 text-xs font-medium text-surface bg-accent transition-all duration-200 hover:brightness-110 active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Send className="h-4 w-4" />
                Send
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
