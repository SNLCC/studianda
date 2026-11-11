import type { RuntimeInfo, UpdateState } from '@studianda/shared';

declare module '*?url' {
  const src: string;
  export default src;
}

declare global {
  interface Window {
    studianda: {
      getRuntime(): Promise<RuntimeInfo | null>;
      pickPdf(): Promise<string | null>;
      pickDirectory(): Promise<string | null>;
      pickMarkdownVault(): Promise<string | null>;
      openNoteAsset(url: string): Promise<{ ok: boolean; message: string }>;
      getSecretStatus(): Promise<{ encryptionAvailable: boolean; configured: string[] }>;
      setSecret(name: string, value: string): Promise<{ encryptionAvailable: boolean; configured: string[] }>;
      clearSecret(name: string): Promise<{ encryptionAvailable: boolean; configured: string[] }>;
      getDataLocation(): Promise<string>;
      openDataLocation(): Promise<{ ok: boolean; message: string }>;
      getDataSetup(): Promise<{ configured: boolean; current: string }>;
      setupDataLocation(): Promise<{ ok: boolean; message: string }>;
      openLegalNotice(): Promise<{ ok: boolean }>;
      changeDataLocation(): Promise<{ ok: boolean; message: string }>;
      openExternal(url: string): Promise<{ ok: boolean; message?: string }>;
      saveBlob(data: Uint8Array, filename: string): Promise<{ ok: boolean; message?: string }>;
      clearUserDataLogs(): Promise<{ ok: boolean; removed: string[] }>;
      openTranslationWindow?(input: {
        documentId: string;
        page: number;
      }): Promise<{ ok: boolean; message?: string }>;
      update: {
        getState(): Promise<UpdateState | null>;
        getAutoCheck(): Promise<boolean | null>;
        setAutoCheck(enabled: boolean): Promise<boolean | null>;
        check(manual: boolean): Promise<UpdateState | null>;
        download(): Promise<UpdateState | null>;
        install(): Promise<{ ok: boolean; message?: string }>;
        onStatus(callback: (state: UpdateState) => void): () => void;
      };
      windowControls: {
        minimize(): void;
        toggleMaximize(): void;
        close(): void;
        isMaximized(): Promise<boolean>;
        onMaximized(callback: (maximized: boolean) => void): () => void;
      };
    };
  }
}

export {};
