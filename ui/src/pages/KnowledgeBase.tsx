import { useState } from "react";
import { useParams } from "react-router-dom";
import {
  BookOpen,
  Plus,
  Search,
  Trash2,
  FileText,
  Tag,
  Layers,
  X,
  ChevronRight,
} from "lucide-react";
import {
  useKnowledgeDocs,
  useAddKnowledgeDoc,
  useDeleteKnowledgeDoc,
  useSearchKnowledge,
} from "@/lib/hooks";
import type { KnowledgeSearchResult } from "@/lib/api";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input, Textarea } from "@/components/ui/Input";

export function KnowledgeBase() {
  const { companyId } = useParams();
  const { data: documents, isLoading } = useKnowledgeDocs(companyId);
  const addDoc = useAddKnowledgeDoc(companyId!);
  const deleteDoc = useDeleteKnowledgeDoc(companyId!);
  const searchMutation = useSearchKnowledge(companyId!);

  // Modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newTags, setNewTags] = useState("");

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<KnowledgeSearchResult[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  // Detail view state
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newContent.trim()) return;

    const tags = newTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    await addDoc.mutateAsync({ title: newTitle, content: newContent, tags });
    setNewTitle("");
    setNewContent("");
    setNewTags("");
    setShowAddModal(false);
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) {
      setSearchResults(null);
      return;
    }
    setIsSearching(true);
    try {
      const res = await searchMutation.mutateAsync(searchQuery);
      // unwrap { data: ... } envelope
      const results = res && typeof res === "object" && "data" in res
        ? (res as any).data
        : res;
      setSearchResults(Array.isArray(results) ? results : []);
    } finally {
      setIsSearching(false);
    }
  };

  const clearSearch = () => {
    setSearchQuery("");
    setSearchResults(null);
  };

  const handleDelete = async (docId: string) => {
    if (!window.confirm("Delete this document and all its chunks?")) return;
    await deleteDoc.mutateAsync(docId);
    if (selectedDocId === docId) setSelectedDocId(null);
  };

  const selectedDoc = documents?.find((d) => d.id === selectedDocId);

  const formatDate = (dateStr: string) => {
    const d = new Date(typeof dateStr === "number" ? dateStr : dateStr);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  /**
   * Highlight matching query terms in a text snippet.
   */
  const highlightMatches = (text: string, query: string) => {
    if (!query.trim()) return text;
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);
    if (words.length === 0) return text;

    const pattern = new RegExp(`(${words.map(escapeRegex).join("|")})`, "gi");
    const parts = text.split(pattern);
    return parts.map((part, i) =>
      words.some((w) => part.toLowerCase() === w) ? (
        <mark
          key={i}
          className="bg-amber-500/25 text-amber-300 rounded-sm px-0.5"
        >
          {part}
        </mark>
      ) : (
        part
      ),
    );
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary font-display tracking-wide flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/15">
              <BookOpen className="h-4.5 w-4.5 text-amber-400" />
            </div>
            Knowledge Base
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            Company knowledge for agent context and semantic search
          </p>
        </div>
        <Button
          icon={<Plus className="h-3.5 w-3.5" />}
          onClick={() => setShowAddModal(true)}
          className="!bg-amber-500 hover:!bg-amber-400 !text-black"
        >
          Add Document
        </Button>
      </div>

      {/* Search Bar */}
      <Card padding={false}>
        <form onSubmit={handleSearch} className="flex items-center gap-3 px-5 py-3.5">
          <Search className="h-4 w-4 text-text-secondary shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search knowledge base..."
            className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-secondary/50 outline-none"
          />
          {searchResults !== null && (
            <button
              type="button"
              onClick={clearSearch}
              className="rounded-md p-1 text-text-secondary hover:text-amber-400 hover:bg-white/[0.05] transition-all cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <Button
            type="submit"
            size="sm"
            loading={isSearching}
            className="!bg-amber-500/15 !text-amber-400 hover:!bg-amber-500/25"
          >
            Search
          </Button>
        </form>
      </Card>

      {/* Search Results */}
      {searchResults !== null && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-text-primary font-display">
              Search Results
            </h2>
            <Badge variant="warning">{searchResults.length} matches</Badge>
          </div>

          {searchResults.length === 0 ? (
            <Card>
              <p className="text-sm text-text-secondary text-center py-4">
                No results found for "{searchQuery}"
              </p>
            </Card>
          ) : (
            <div className="space-y-2">
              {searchResults.map((result, idx) => (
                <Card key={`${result.chunk.id}-${idx}`} hoverable padding={false}>
                  <div className="p-4">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <FileText className="h-3.5 w-3.5 text-amber-400" />
                        <span className="text-xs font-semibold text-amber-400 font-display">
                          {result.documentTitle}
                        </span>
                      </div>
                      <Badge variant="default">
                        {(result.score * 100).toFixed(0)}% match
                      </Badge>
                    </div>
                    <p className="text-sm text-text-secondary leading-relaxed line-clamp-4">
                      {highlightMatches(result.chunk.content, searchQuery)}
                    </p>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Main Content */}
      {searchResults === null && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Document List */}
          <div className="lg:col-span-2 space-y-3">
            {isLoading ? (
              <Card>
                <div className="flex items-center justify-center py-12">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
                </div>
              </Card>
            ) : !documents?.length ? (
              <EmptyState
                icon={<BookOpen className="h-6 w-6" />}
                title="No documents yet"
                description="Add documents to build your company's knowledge base. Agents will reference this knowledge when executing tasks."
                action={
                  <Button
                    icon={<Plus className="h-3.5 w-3.5" />}
                    onClick={() => setShowAddModal(true)}
                    className="!bg-amber-500 hover:!bg-amber-400 !text-black"
                  >
                    Add First Document
                  </Button>
                }
              />
            ) : (
              documents.map((doc) => (
                <Card
                  key={doc.id}
                  hoverable
                  padding={false}
                  onClick={() => setSelectedDocId(doc.id)}
                  className={
                    selectedDocId === doc.id
                      ? "!border-amber-500/30 ring-1 ring-amber-500/20"
                      : ""
                  }
                >
                  <div className="flex items-start justify-between p-4">
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10">
                        <FileText className="h-4 w-4 text-amber-400" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-semibold text-text-primary font-display truncate">
                          {doc.title}
                        </h3>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
                          <span className="flex items-center gap-1">
                            <Layers className="h-3 w-3" />
                            {doc.chunkCount} chunks
                          </span>
                          <span className="text-white/10">|</span>
                          <span>{doc.source ?? "manual"}</span>
                          <span className="text-white/10">|</span>
                          <span>{formatDate(doc.createdAt)}</span>
                        </div>
                        {doc.tags && doc.tags.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {(doc.tags as string[]).map((tag) => (
                              <span
                                key={tag}
                                className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 text-[10px] font-medium text-amber-400"
                              >
                                <Tag className="h-2.5 w-2.5" />
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0 ml-3">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(doc.id);
                        }}
                        className="rounded-lg p-1.5 text-text-secondary hover:text-error hover:bg-error/10 transition-all cursor-pointer"
                        title="Delete document"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                      <ChevronRight className="h-4 w-4 text-text-secondary/50" />
                    </div>
                  </div>
                </Card>
              ))
            )}
          </div>

          {/* Detail Panel */}
          <div className="lg:col-span-1">
            {selectedDoc ? (
              <Card padding={false} className="sticky top-6">
                <div className="border-b border-white/[0.06] px-5 py-3.5">
                  <h3 className="text-sm font-semibold text-text-primary font-display truncate">
                    {selectedDoc.title}
                  </h3>
                  <div className="mt-1 flex items-center gap-2 text-xs text-text-secondary">
                    <Badge variant="warning">{selectedDoc.chunkCount} chunks</Badge>
                    <Badge variant="default">{selectedDoc.contentType}</Badge>
                  </div>
                </div>
                <div className="p-5 max-h-[60vh] overflow-y-auto">
                  <pre className="text-xs text-text-secondary whitespace-pre-wrap leading-relaxed font-mono">
                    {selectedDoc.content.length > 3000
                      ? selectedDoc.content.slice(0, 3000) + "\n\n... (truncated)"
                      : selectedDoc.content}
                  </pre>
                </div>
              </Card>
            ) : (
              <Card className="border border-dashed border-white/[0.08]">
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <BookOpen className="h-8 w-8 text-text-secondary/30 mb-3" />
                  <p className="text-xs text-text-secondary">
                    Select a document to preview its content
                  </p>
                </div>
              </Card>
            )}
          </div>
        </div>
      )}

      {/* Add Document Modal */}
      <Modal
        open={showAddModal}
        onClose={() => setShowAddModal(false)}
        title="Add Document"
        className="!max-w-2xl"
      >
        <form onSubmit={handleAdd} className="space-y-4">
          <Input
            label="Title"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="e.g., Company Style Guide"
            required
          />
          <Textarea
            label="Content"
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            placeholder="Paste your document content here (Markdown supported)..."
            rows={14}
            required
          />
          <Input
            label="Tags"
            value={newTags}
            onChange={(e) => setNewTags(e.target.value)}
            placeholder="Comma-separated tags (e.g., engineering, process, style)"
          />
          <div className="flex justify-end gap-3 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setShowAddModal(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              loading={addDoc.isPending}
              className="!bg-amber-500 hover:!bg-amber-400 !text-black"
            >
              Add Document
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
