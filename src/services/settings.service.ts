import { prisma } from '../config/db';

class SettingsService {
  private cache: Record<string, string> | null = null;
  private lastFetch = 0;
  private TTL = 60000;

  public readonly defaults: Record<string, string> = {
    // Global
    global_alert: '',
    maintenance_mode: 'false',

    // Auth
    auth_require_email_verification: 'true',
    auth_passkey_enabled: 'true',
    auth_login_attempts: '10',
    auth_login_window_minutes: '15',
    auth_password_min_length: '12',
    auth_password_require_upper: 'true',
    auth_password_require_lower: 'true',
    auth_password_require_number: 'true',
    auth_password_require_special: 'true',

    // Session
    session_idle_minutes: '60',
    session_remember_days: '7',
    session_version: '1',

    // Limits
    limit_matches_per_day_free: '10',
    limit_matches_per_day_pro: '100',
    limit_matches_per_day_enterprise: '0',
    limit_api_keys_free: '3',
    limit_api_keys_pro: '10',
    limit_api_keys_enterprise: '0',
    limit_models_per_user_free: '3',
    limit_models_per_user_pro: '10',
    limit_models_per_user_enterprise: '0',
    limit_admin_ai_chats: '10',

    // Queue
    queue_retry_attempts: '3',
    queue_retry_backoff_ms: '5000',
    queue_concurrency: '2',
    queue_max_turns: '250',
    queue_auto_clean_enabled: 'false',
    queue_auto_clean_interval_minutes: '60',

    // Security headers
    security_hsts_enabled: 'true',
    security_hsts_max_age: '15552000',
    security_csp_allow_unsafe_eval: 'true',
    security_csp_script_src: '',
    security_csp_style_src: '',
    security_csp_img_src: '',
    security_csp_connect_src: '',
    security_csp_font_src: '',

    // Uploads
    upload_max_mb: '5',

    // Communications
    comms_email_enabled: 'true',
    comms_email_test_address: '',
    comms_sms_enabled: 'true',
    comms_sms_test_number: '',
    comms_sms_provider: 'auto',

    // Defaults
    default_user_tier: 'FREE',

    // Chat Visibility/Configurability for Users
    user_can_toggle_chat_notifications: 'true',
    user_can_toggle_chat_sound: 'true',
    user_can_change_chat_rate_limit: 'true',
    user_can_toggle_chat_presence: 'true'
  };

  async getAll(): Promise<Record<string, string>> {
    if (this.cache && Date.now() - this.lastFetch < this.TTL) {
      return this.cache;
    }

    const settings = await prisma.systemSetting.findMany();
    const map = { ...this.defaults };
    settings.forEach(s => {
      map[s.key] = s.value;
    });

    this.cache = map;
    this.lastFetch = Date.now();
    return map;
  }

  async update(key: string, value: string) {
    await prisma.systemSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value }
    });

    this.cache = null;
  }
}

export const settingsService = new SettingsService();
