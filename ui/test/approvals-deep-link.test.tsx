import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { Approvals } from '../src/pages/Approvals';
import { useApproval } from '../src/lib/hooks';

vi.mock('../src/lib/hooks', () => ({
  useApprovals: () => ({ data: [], isLoading: false }),
  useApproval: vi.fn(() => ({ data: undefined, isLoading: false, isError: true })),
  useDecideApproval: () => ({}),
  useCancelApproval: () => ({}),
  useAddApprovalComment: () => ({}),
  useCreateApproval: () => ({}),
}));
vi.mock('../src/components/ui/PageTransition', () => ({
  PageTransition: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../src/components/projects/MissionPlanGateApproval', () => ({
  MissionPlanGateApproval: () => null,
}));

it('loads the exact focused approval even when absent from the pending list', () => {
  render(
    <MemoryRouter initialEntries={['/companies/company/approvals?focus=target-approval']}>
      <Routes>
        <Route path="/companies/:companyId/approvals" element={<Approvals />} />
      </Routes>
    </MemoryRouter>,
  );
  expect(useApproval).toHaveBeenCalledWith('company', 'target-approval');
  expect(screen.getByText('Approval unavailable')).toBeInTheDocument();
});
