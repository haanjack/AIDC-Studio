import { create } from 'zustand';
import { useApp } from '../store/appStore.ts';

// Network panel tab state lives outside panels/NetworkPanel.tsx so Overview / help links can open a tab (e.g. the IP map) directly.

export type NetworkTabId = 'fabric' | 'clusters' | 'placement' | 'traffic' | 'schedule' | 'ip';

export const useNetworkNav = create<{ tab: NetworkTabId; setTab: (tab: NetworkTabId) => void }>((set) => ({
  tab: 'fabric',
  setTab: (tab) => set({ tab }),
}));

/** Opens Network › IP map. */
export function openIpMap(): void {
  useNetworkNav.getState().setTab('ip');
  const s = useApp.getState();
  if (s.page !== 'network') s.setPage('network');
}
