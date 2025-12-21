export interface LLMConfig {
    apiKey: string;
    baseURL: string;
    model: string;
    temperature?: number;
}

export interface Message {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface CompletionOptions {
    messages: Message[];
    max_tokens?: number;
    temperature?: number; // Override config
}

export class LLMClient {
    private config: Required<LLMConfig>;

    constructor(config: LLMConfig) {
        this.config = {
            apiKey: config.apiKey,
            baseURL: config.baseURL,
            model: config.model,
            temperature: config.temperature ?? 0.3,
        };
    }

    async chat(options: CompletionOptions): Promise<string> {
        const url = `${this.config.baseURL}/chat/completions`;

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.config.apiKey}`,
                    'Content-Type': 'application/json',
                    // OpenRouter recommended headers
                    'HTTP-Referer': 'https://github.com/GabrielDrapor/ovid',
                    'X-Title': 'Ovid Translator',
                },
                body: JSON.stringify({
                    model: this.config.model,
                    messages: options.messages,
                    temperature: options.temperature ?? this.config.temperature,
                    max_tokens: options.max_tokens,
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API Error ${response.status}: ${errorText}`);
            }

            const data = (await response.json()) as any;
            const content = data.choices[0]?.message?.content?.trim();

            if (!content) {
                throw new Error('Empty response from LLM API');
            }

            return content;
        } catch (error) {
            // Re-throw to let caller handle logging/fallback
            throw error;
        }
    }

    getConfig(): Required<LLMConfig> {
        return { ...this.config };
    }
}
