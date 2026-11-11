import { create } from 'zustand';

export interface AppState {
  activeView: 'library' | 'reader' | 'settings';
  setActiveView(view: AppState['activeView']): void;
}

export const useAppStore = create<AppState>((set) => ({
  activeView: 'library',
  setActiveView: (activeView) => set({ activeView })
}));
