export const PRODUCT_NAME = "Pi Backtest";
export const PRODUCT_DESCRIPTION = "A strategy research workbench powered by Pi";

export function formatProductWindowTitle(projectName: string | null): string {
  return projectName ? `${projectName} - ${PRODUCT_NAME}` : PRODUCT_NAME;
}
