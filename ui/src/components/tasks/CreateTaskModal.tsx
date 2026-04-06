import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useCreateTask } from "@/lib/hooks";
import type { Task } from "@/lib/api";

interface CreateTaskModalProps {
  open: boolean;
  onClose: () => void;
  companyId: string;
}

const priorityOptions = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

const typeOptions = [
  { value: "feature", label: "Feature" },
  { value: "bug", label: "Bug" },
  { value: "chore", label: "Chore" },
  { value: "spike", label: "Spike" },
  { value: "epic", label: "Epic" },
];

export function CreateTaskModal({ open, onClose, companyId }: CreateTaskModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Task["priority"]>("medium");
  const [type, setType] = useState<Task["type"]>("feature");

  const mutation = useCreateTask(companyId);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate(
      { title, description, priority, type },
      {
        onSuccess: () => {
          onClose();
          setTitle("");
          setDescription("");
          setPriority("medium");
          setType("feature");
        },
      },
    );
  };

  return (
    <Modal open={open} onClose={onClose} title="Create Task">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Title"
          placeholder="What needs to be done?"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
        <Textarea
          label="Description"
          placeholder="Describe the task in detail..."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Priority"
            options={priorityOptions}
            value={priority}
            onChange={(e) => setPriority(e.target.value as Task["priority"])}
          />
          <Select
            label="Type"
            options={typeOptions}
            value={type}
            onChange={(e) => setType(e.target.value as Task["type"])}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            Create Task
          </Button>
        </div>
      </form>
    </Modal>
  );
}
