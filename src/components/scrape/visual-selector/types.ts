export interface SelectorMatch {
  index: number;
  tag: string;
  text: string;
  attrs: Record<string, string>;
}

export interface AiSuggestion {
  type: string;
  label: string;
  selector: string;
}

export interface VisualSelectorBuilderProps {
  onSelectorGenerated: (selector: {
    type: 'css' | 'xpath' | 'regex';
    value: string;
  }) => void;
  onClose: () => void;
  initialUrl?: string;
}
