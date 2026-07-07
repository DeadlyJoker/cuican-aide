export type ConfirmHandler = (message: string) => boolean | Promise<boolean>;

export type ConfirmDialogRequest = {
  message: string;
};
