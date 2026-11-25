-- Migration 0017_template_covers: preview covers of the built-in templates.
-- PNGs rendered by apps/api/scripts/template-covers.ts and stored at
-- public/templates/<id>/cover.png; the API builds `coverUrl` from `meta.coverKey`
-- with the public media URL builder (D-008).
UPDATE templates SET meta = json_set(COALESCE(meta, '{}'), '$.coverKey', 'public/templates/' || id || '/cover.png'), updated_at = updated_at
  WHERE workspace_id IS NULL AND id IN ('tpl_tv_ad_15s', 'tpl_product_showcase', 'tpl_talking_head', 'tpl_comic_page', 'tpl_character_sheet', 'tpl_storyboard', 'tpl_holiday_greeting', 'tpl_outfit_try_on');
