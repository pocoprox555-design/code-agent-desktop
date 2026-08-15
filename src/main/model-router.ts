/**
 * Model Router — مسارات النماذج المتعددة
 *
 * يختار النموذج المناسب حسب نوع المهمة:
 * - Action model (سريع، رخيص) للتعديلات البسيطة وجمع المعلومات
 * - Thinking model (قوي، بطيء) للتخطيط والتحليل المعقد
 * - Critique model يراجع عمل الوكيل قبل التسليم
 *
 * يحسن الكفاءة والتكلفة بشكل كبير.
 */

import { GO_MODELS, GO_MODEL_COSTS } from '../shared/models'
import type { ApiStyle, ProviderConfig } from '../shared/types'

// ─── Types ───────────────────────────────────────────────────────────

export type TaskRole = 'action' | 'thinking' | 'critique' | 'compact' | 'subagent'

export interface ModelRoute {
  modelId: string
  apiStyle: ApiStyle
  contextWindow: number
  maxOutputTokens: number
}

export interface RoutingConfig {
  /** النموذج الافتراضي (المستخدمه حالياً) */
  defaultModel: string
  /** نموذج الإجراءات السريعة */
  actionModel?: string
  /** نموذج التفكير العميق */
  thinkingModel?: string
  /** نموذج المراجعة */
  critiqueModel?: string
  /** نموذج ضغط السياق */
  compactModel?: string
  /** نموذج الوكلاء الفرعيين */
  subagentModel?: string
}

// ─── Model Categories (تصنيف النماذج) ─────────────────────────────────

/** نماذج سريعة ورخيصة — مناسبة للقراءة والبحث والتعديلات البسيطة */
const FAST_MODELS = new Set([
  'deepseek-v4-flash',
  'minimax-m2.7',
  'qwen3.6-plus',
  'qwen3.7-plus',
  'hy3',
  'kimi-k2.7-code',
])

/** نماذج قوية ومنطقية — مناسبة للتخطيط والتحليل المعقد */
const THINKING_MODELS = new Set([
  'deepseek-v4-pro',
  'qwen3.7-max',
  'qwen3.8-max',
  'mimo-v2.5-pro',
  'gpt-5.6-luna',
  'glm-5.2',
])

/** نماذج متوسطة — مناسبة للمراجعة والضغط */
const BALANCED_MODELS = new Set([
  'mimo-v2.5',
  'minimax-m3',
  'glm-5.1',
  'kimi-k3',
])

// ─── ModelRouter ─────────────────────────────────────────────────────

export class ModelRouter {
  private config: RoutingConfig

  constructor(config: RoutingConfig) {
    this.config = config
  }

  /**
   * اختيار النموذج حسب نوع المهمة
   */
  route(role: TaskRole, currentModel?: string): ModelRoute {
    // إذا كان هناك نموذج محدد للدور، استخدمه
    const roleModel = this.getModelForRole(role)
    if (roleModel) {
      return this.buildRoute(roleModel)
    }

    // إذا كان النموذج الحالي سريع بما يكفي للدور، استخدمه
    if (currentModel && this.isSuitableForRole(currentModel, role)) {
      return this.buildRoute(currentModel)
    }

    // خيار افتراضي حسب الدور
    return this.buildRoute(this.getDefaultForRole(role))
  }

  /**
   * تحليل المهمة واختيار أفضل نموذج
   * يُستخدم عندما لا يكون الدور واضحًا
   */
  analyzeAndRoute(taskDescription: string, currentModel?: string): ModelRoute {
    const lower = taskDescription.toLowerCase()

    // تحديد الدور من وصف المهمة
    if (this.isComplexTask(lower)) {
      return this.route('thinking', currentModel)
    }
    if (this.isSimpleTask(lower)) {
      return this.route('action', currentModel)
    }
    if (this.isReviewTask(lower)) {
      return this.route('critique', currentModel)
    }

    // الافتراضي: استخدم النموذج الحالي
    return this.route('action', currentModel)
  }

  /**
   * الحصول على معلومات التكلفة لكل نموذج
   */
  getCostInfo(modelId: string): { input: number; output: number; label: string } | undefined {
    const cost = GO_MODEL_COSTS[modelId]
    if (!cost) return undefined
    return {
      input: cost.input,
      output: cost.output,
      label: `${modelId} ($${cost.input}/M input, $${cost.output}/M output)`
    }
  }

  /**
   * قائمة النماذج المقترحة لكل دور
   */
  getSuggestions(): Record<TaskRole, Array<{ modelId: string; reason: string }>> {
    return {
      action: [
        { modelId: 'deepseek-v4-flash', reason: 'سريع ورخيص ($0.27/M input)' },
        { modelId: 'minimax-m2.7', reason: 'رخيص جدًا ($0.2/M input)' },
        { modelId: 'qwen3.7-plus', reason: 'متوازن السعر والأداء' },
      ],
      thinking: [
        { modelId: 'deepseek-v4-pro', reason: 'قوي في التحليل ($1.2/M input)' },
        { modelId: 'qwen3.8-max', reason: 'آخر نموذج Qwen ($0.8/M input)' },
        { modelId: 'gpt-5.6-luna', reason: 'GPT الأحدث مع reasoning' },
      ],
      critique: [
        { modelId: 'mimo-v2.5', reason: 'متوازن للمراجعة' },
        { modelId: 'glm-5.2', reason: 'جيد في اكتشاف الأخطاء' },
      ],
      compact: [
        { modelId: 'deepseek-v4-flash', reason: 'سريع للضغط' },
        { modelId: 'minimax-m2.7', reason: 'رخيص للمهمات البسيطة' },
      ],
      subagent: [
        { modelId: 'deepseek-v4-flash', reason: 'سريع للوكلاء الفرعيين' },
        { modelId: 'qwen3.6-plus', reason: 'متوازن' },
      ],
    }
  }

  // ─── Private ────────────────────────────────────────────────────

  private getModelForRole(role: TaskRole): string | undefined {
    switch (role) {
      case 'action': return this.config.actionModel
      case 'thinking': return this.config.thinkingModel
      case 'critique': return this.config.critiqueModel
      case 'compact': return this.config.compactModel
      case 'subagent': return this.config.subagentModel
    }
  }

  private getDefaultForRole(role: TaskRole): string {
    switch (role) {
      case 'action': return this.config.defaultModel
      case 'thinking': return this.config.defaultModel // استخدام الافتراضي إذا لم يُحدد thinking model
      case 'critique': return this.config.defaultModel
      case 'compact': return this.config.defaultModel
      case 'subagent': return this.config.defaultModel
    }
  }

  private isSuitableForRole(modelId: string, role: TaskRole): boolean {
    switch (role) {
      case 'action': return FAST_MODELS.has(modelId) || BALANCED_MODELS.has(modelId)
      case 'thinking': return THINKING_MODELS.has(modelId)
      case 'critique': return THINKING_MODELS.has(modelId) || BALANCED_MODELS.has(modelId)
      case 'compact': return FAST_MODELS.has(modelId)
      case 'subagent': return FAST_MODELS.has(modelId)
    }
  }

  private isComplexTask(description: string): boolean {
    const complexIndicators = [
      'خطط', 'حلل', 'صمم', 'هندسة', 'معقد', 'معمارية',
      'plan', 'analyze', 'design', 'architecture', 'complex',
      'مراجعة شاملة', 'comprehensive review', 'اكتب تقرير',
    ]
    return complexIndicators.some((indicator) => description.includes(indicator))
  }

  private isSimpleTask(description: string): boolean {
    const simpleIndicators = [
      'اقرأ', 'ابحث', 'عدّل', 'اكتب', 'احذف',
      'read', 'search', 'edit', 'write', 'delete',
      'ملف', 'file', 'سطر', 'line',
    ]
    return simpleIndicators.some((indicator) => description.includes(indicator))
  }

  private isReviewTask(description: string): boolean {
    const reviewIndicators = [
      'راجع', 'تحقق', 'اختبر', 'أثبت',
      'review', 'verify', 'test', 'validate',
      'جودة', 'quality', 'error', 'bug',
    ]
    return reviewIndicators.some((indicator) => description.includes(indicator))
  }

  private buildRoute(modelId: string): ModelRoute {
    const model = GO_MODELS.find((m) => m.id === modelId) ?? GO_MODELS[0]!
    return {
      modelId: model.id,
      apiStyle: model.apiStyle,
      contextWindow: model.contextWindow,
      maxOutputTokens: 131_072,
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────────────

/**
 * إنشاء ModelRouter من إعدادات المستخدم
 */
export function createModelRouter(userModel: string, routingConfig?: Partial<RoutingConfig>): ModelRouter {
  return new ModelRouter({
    defaultModel: userModel,
    // لا نستبدل النموذج تلقائيًا: يبقى النموذج الذي اختاره المستخدم هو المستخدم
    // في كل الأدوار (الضغط/الوكلاء الفرعيون/الخطوات) ما لم يُحدَّد صراحةً في routingConfig.
    ...routingConfig,
  })
}
