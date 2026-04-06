import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Input, Textarea } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";
import { useCreateCompany } from "@/lib/hooks";

interface CreateCompanyModalProps {
  open: boolean;
  onClose: () => void;
}

export function CreateCompanyModal({ open, onClose }: CreateCompanyModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mission, setMission] = useState("");
  const [budget, setBudget] = useState("");

  const mutation = useCreateCompany();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate(
      {
        name,
        description,
        mission,
        budgetMonthlyCents: budget ? Math.round(Number(budget) * 100) : undefined,
      },
      {
        onSuccess: () => {
          onClose();
          setName("");
          setDescription("");
          setMission("");
          setBudget("");
        },
      },
    );
  };

  return (
    <Modal open={open} onClose={onClose} title="Create Company">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Company Name"
          placeholder="e.g., Eidolon Labs"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Textarea
          label="Description"
          placeholder="What does this company do?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
        />
        <Textarea
          label="Mission"
          placeholder="What is the company's mission?"
          value={mission}
          onChange={(e) => setMission(e.target.value)}
          rows={2}
        />
        <Input
          label="Monthly Budget (USD)"
          type="number"
          placeholder="e.g., 10000"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          min="0"
          step="100"
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            Create Company
          </Button>
        </div>
      </form>
    </Modal>
  );
}
