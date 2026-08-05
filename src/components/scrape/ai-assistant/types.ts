export interface GeneratedRule {
  name: string;
  description: string;
  engine: string;
  listUrl: string;
  listSelector: { type: string; value: string };
  listPagination: { type: string; selector: string; maxPage: number };
  bookTitleSelector: { type: string; value: string };
  bookAuthorSelector: { type: string; value: string };
  bookDescriptionSelector: { type: string; value: string };
  bookCoverSelector: { type: string; value: string };
  bookStatusSelector: { type: string; value: string };
  chapterListSelector: { type: string; value: string };
  chapterTitleSelector: { type: string; value: string };
  chapterLinkSelector: { type: string; value: string };
  contentSelector: { type: string; value: string };
  contentTitleSelector: { type: string; value: string };
  antiCrawlConfig: {
    useJsRender: boolean;
    uaRotation: boolean;
    minDelay: number;
    maxDelay: number;
  };
  agentqlQueries?: {
    title?: string;
    author?: string;
    description?: string;
    chapters?: string;
    content?: string;
  };
  confidence: number;
  notes: string[];
}

export interface AiRuleAssistantProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApplyRule: (rule: GeneratedRule) => void;
}

export type Step = 'input' | 'analyzing' | 'result';
