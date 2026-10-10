/** App-level actions registered by App.tsx, callable from dialogs without prop drilling. */
export const appActions = {
  /** Re-scan the current folder (after files were moved). */
  reopen: async (): Promise<void> => {},
};
