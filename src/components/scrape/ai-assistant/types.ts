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
    useProxy?: boolean;
    useCookies?: boolean;
    useSession?: boolean;
    useStealth?: boolean;
    humanBehavior?: boolean;
    dnt?: boolean;
    acceptLanguage?: string;
    referer?: string;
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

export interface AdvisorRecommendation {
  id: string;
  title: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  category: string;
  applied: boolean;
}

export interface AdvisorReport {
  domain: string;
  threatLevel: 'low' | 'medium' | 'high';
  recommendations: AdvisorRecommendation[];
  suggestedEngine?: string;
}

export interface SmartGenerateResult {
  success: boolean;
  rule: GeneratedRule | null;
  advisorReport?: AdvisorReport;
  appliedRecommendations?: string[];
  error?: string | null;
}

export interface AiRuleAssistantProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApplyRule: (rule: GeneratedRule) => void;
}

export type Step = 'input' | 'analyzing' | 'result';
