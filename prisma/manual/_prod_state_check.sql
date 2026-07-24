-- ============================================================================
-- PROD DB STATE CHECK  (READ-ONLY — safe to run anytime, changes nothing)
-- Run this against the LIVE PROD Supabase DB (SQL Editor) to see which manual
-- migrations are already applied. Then apply only the ones showing "MISSING",
-- in file order, per GO_LIVE_RUNBOOK.md §2.
--
-- IMPORTANT: wp_quests.sql (#1) is NOT idempotent (bare CREATE TABLE). Run it
-- ONLY if "app_users table (#1 WP base)" shows MISSING. All other files use
-- IF NOT EXISTS and are safe to re-run.
-- ============================================================================
SELECT check_name, CASE WHEN present THEN 'OK (present)' ELSE '❌ MISSING — apply file' END AS status, source_file
FROM (
  VALUES
    ('app_users table (#1 WP base)',
       to_regclass('public.app_users') IS NOT NULL,                                                        'wp_quests.sql'),
    ('app_settings.wpMonthlyCapWp (#1 tail)',
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='app_settings' AND column_name='wpMonthlyCapWp'), 'wp_quests.sql'),
    ('wp_redemptions.fulfillmentNote (#2)',
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='wp_redemptions' AND column_name='fulfillmentNote'), 'wp_lengkap_wave1.sql'),
    ('wp_conversions table (#3)',
       to_regclass('public.wp_conversions') IS NOT NULL,                                                    'wp_conversion_wave2.sql'),
    ('app_settings.wpConversionEnabled (#3)',
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='app_settings' AND column_name='wpConversionEnabled'), 'wp_conversion_wave2.sql'),
    ('WpConversionStatus enum (#3)',
       EXISTS (SELECT 1 FROM pg_type WHERE typname='WpConversionStatus'),                                   'wp_conversion_wave2.sql'),
    ('app_users.username + name/phone/avatarUrl (#4)',
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='app_users' AND column_name='username'), 'wp_profile_devbypass_wave3.sql'),
    ('app_users_username_key unique index (#4)',
       EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='app_users_username_key'),                          'wp_profile_devbypass_wave3.sql'),
    ('WpFraudReviewStatus enum (#5)',
       EXISTS (SELECT 1 FROM pg_type WHERE typname='WpFraudReviewStatus'),                                  'wp_backoffice_gaps_wave4.sql'),
    ('app_users.fraudReviewStatus (#5)',
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='app_users' AND column_name='fraudReviewStatus'), 'wp_backoffice_gaps_wave4.sql'),
    ('merchants.category is TEXT not enum (#6)',
       (SELECT data_type='text' FROM information_schema.columns WHERE table_name='merchants' AND column_name='category'), 'fix_merchant_category_to_text.sql'),
    ('vouchers.coverImageUrl (#7)',
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='vouchers' AND column_name='coverImageUrl'), 'add_voucher_cover_image.sql')
) AS checks(check_name, present, source_file)
ORDER BY source_file, check_name;
