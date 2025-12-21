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

export interface Tool {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: Record<string, any>;
    };
    implementation?: (args: any) => Promise<any> | any;
}

export interface CompletionOptions {
    messages: Message[];
    max_tokens?: number;
    temperature?: number; // Override config
    tools?: Tool[];
    tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
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
        let messages = [...options.messages];
        let iterations = 0;
        const MAX_ITERATIONS = 5; // Prevent infinite loops

        while (iterations < MAX_ITERATIONS) {
            iterations++;

            try {
                const body: any = {
                    model: this.config.model,
                    messages: messages,
                    temperature: options.temperature ?? this.config.temperature,
                    max_tokens: options.max_tokens,
                };

                if (options.tools && options.tools.length > 0) {
                    body.tools = options.tools.map(({ implementation, ...rest }) => rest);
                    body.tool_choice = options.tool_choice || 'auto';
                }

                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.config.apiKey.trim()}`,
                        'Content-Type': 'application/json',
                        'HTTP-Referer': 'https://github.com/GabrielDrapor/ovid',
                        'X-Title': 'Ovid',
                    },
                    body: JSON.stringify(body),
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`API Error ${response.status}: ${errorText}`);
                }

                const data = (await response.json()) as any;
                const choice = data.choices[0];
                const message = choice.message;

                // If simple content response, we are active
                if (choice.finish_reason !== 'tool_calls' && !message.tool_calls) {
                    const content = message.content?.trim();
                    if (!content && !message.content) {
                        throw new Error('Empty response from LLM API');
                    }
                    return content || '';
                }

                // Handle Tool Calls
                if (message.tool_calls) {
                    messages.push(message); // Add assistant's tool_call message

                    for (const toolCall of message.tool_calls) {
                        const toolName = toolCall.function.name;
                        const tool = options.tools?.find(t => t.function.name === toolName);

                        let result = '';
                        if (tool && tool.implementation) {
                            try {
                                const args = JSON.parse(toolCall.function.arguments);
                                const output = await tool.implementation(args);
                                result = typeof output === 'string' ? output : JSON.stringify(output);
                            } catch (e: any) {
                                result = `Error executing tool: ${e.message}`;
                            }
                        } else {
                            result = `Error: Tool ${toolName} not found or no implementation provided.`;
                        }

                        messages.push({
                            role: 'tool',
                            content: result,
                            tool_call_id: toolCall.id,
                        } as any); // Type cast needed because strict Message type likely missing 'tool' role/props
                    }
                    // Loop connects back to top to send tool outputs
                    continue;
                }

                return message.content || '';

            } catch (error) {
                throw error;
            }
        }

        throw new Error('Max tool iteration limit reached');
    }

    getConfig(): Required<LLMConfig> {
        return { ...this.config };
    }
}
