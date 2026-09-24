declare module "pdf-parse" {
  export interface PDFParseOptions {
    data?: Uint8Array;
    pdf?: Uint8Array;
    url?: string;
    password?: string;
  }

  export interface PDFTextResult {
    text: string;
    numpages?: number;
    numrender?: number;
    info?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    version?: string;
  }

  export class PDFParse {
    constructor(options: PDFParseOptions);
    getText(): Promise<PDFTextResult>;
  }
}



