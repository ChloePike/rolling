-- Migration 0021_template_feed_order: built-ins' created_at holds the feed order (round-robin across categories,
-- Home inspiration ones first) so GET /api/templates opens on a mix. Generated from builtinOrderSql() in
-- packages/core/src/templates/builtin.ts.
UPDATE templates SET created_at = 28 WHERE id = 'tpl_tv_ad_15s' AND workspace_id IS NULL;
UPDATE templates SET created_at = 27 WHERE id = 'tpl_talking_head' AND workspace_id IS NULL;
UPDATE templates SET created_at = 26 WHERE id = 'tpl_drama_rooftop' AND workspace_id IS NULL;
UPDATE templates SET created_at = 25 WHERE id = 'tpl_holiday_greeting' AND workspace_id IS NULL;
UPDATE templates SET created_at = 24 WHERE id = 'tpl_comic_page' AND workspace_id IS NULL;
UPDATE templates SET created_at = 23 WHERE id = 'tpl_storyboard' AND workspace_id IS NULL;
UPDATE templates SET created_at = 22 WHERE id = 'tpl_outfit_try_on' AND workspace_id IS NULL;
UPDATE templates SET created_at = 21 WHERE id = 'tpl_product_showcase' AND workspace_id IS NULL;
UPDATE templates SET created_at = 20 WHERE id = 'tpl_presenter_intro' AND workspace_id IS NULL;
UPDATE templates SET created_at = 19 WHERE id = 'tpl_drama_rain_reunion' AND workspace_id IS NULL;
UPDATE templates SET created_at = 18 WHERE id = 'tpl_new_year_countdown' AND workspace_id IS NULL;
UPDATE templates SET created_at = 17 WHERE id = 'tpl_character_sheet' AND workspace_id IS NULL;
UPDATE templates SET created_at = 16 WHERE id = 'tpl_unboxing_reel' AND workspace_id IS NULL;
UPDATE templates SET created_at = 15 WHERE id = 'tpl_product_review' AND workspace_id IS NULL;
UPDATE templates SET created_at = 14 WHERE id = 'tpl_drama_office_twist' AND workspace_id IS NULL;
UPDATE templates SET created_at = 13 WHERE id = 'tpl_valentines_card' AND workspace_id IS NULL;
UPDATE templates SET created_at = 12 WHERE id = 'tpl_lifestyle_scene' AND workspace_id IS NULL;
UPDATE templates SET created_at = 11 WHERE id = 'tpl_how_to_host' AND workspace_id IS NULL;
UPDATE templates SET created_at = 10 WHERE id = 'tpl_drama_letter' AND workspace_id IS NULL;
UPDATE templates SET created_at = 9 WHERE id = 'tpl_halloween_teaser' AND workspace_id IS NULL;
UPDATE templates SET created_at = 8 WHERE id = 'tpl_flat_lay_promo' AND workspace_id IS NULL;
UPDATE templates SET created_at = 7 WHERE id = 'tpl_announcement' AND workspace_id IS NULL;
UPDATE templates SET created_at = 6 WHERE id = 'tpl_drama_cafe' AND workspace_id IS NULL;
UPDATE templates SET created_at = 5 WHERE id = 'tpl_lunar_new_year' AND workspace_id IS NULL;
UPDATE templates SET created_at = 4 WHERE id = 'tpl_feature_closeups' AND workspace_id IS NULL;
UPDATE templates SET created_at = 3 WHERE id = 'tpl_testimonial' AND workspace_id IS NULL;
UPDATE templates SET created_at = 2 WHERE id = 'tpl_drama_cliffhanger' AND workspace_id IS NULL;
UPDATE templates SET created_at = 1 WHERE id = 'tpl_holiday_sale' AND workspace_id IS NULL;
