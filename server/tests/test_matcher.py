import os
import sys
import unittest

SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

import matcher as matcher_mod
import server


class TestProductMatcher(unittest.TestCase):
    def test_parse_volume_and_weight_units(self):
        self.assertAlmostEqual(server.parse_volume_or_weight_grams("1,5 л"), 1500.0)
        self.assertAlmostEqual(server.parse_volume_or_weight_grams("330 мл"), 330.0)
        self.assertAlmostEqual(server.parse_volume_or_weight_grams("0.9 кг"), 900.0)
        self.assertAlmostEqual(server.parse_volume_or_weight_grams("6 x 330 мл"), 1980.0)
        self.assertIsNone(server.parse_volume_or_weight_grams(""))

    def test_build_full_product_search_query_preserves_modifiers_and_volume(self):
        q = server.build_full_product_search_query(
            title="Напиток газированный Добрый Кола без сахара",
            brand="Добрый",
            amount="1,5 л",
        )
        self.assertIn("без сахара", q.lower())
        self.assertIn("1,5 л", q.lower())

        q_no_dup = server.build_full_product_search_query(
            title="Добрый Кола без сахара 1,5 л",
            amount="1,5 л",
        )
        self.assertEqual(q_no_dup.lower().count("1,5 л"), 1)

    def test_sugar_free_never_matches_regular_product(self):
        same_prod, same_vol = server.is_search_result_matching_product(
            res_title="Добрый Кола классическая 1,5 л",
            res_snippet="Купить газированный напиток Добрый Кола 1,5 л по цене 119 руб",
            product_title="Добрый Кола без сахара",
            product_amount="1,5 л",
        )
        self.assertFalse(same_prod)
        self.assertFalse(same_vol)

    def test_regular_product_never_matches_sugar_free_title(self):
        same_prod, same_vol = server.is_search_result_matching_product(
            res_title="Добрый Кола без сахара 1,5 л",
            res_snippet="Напиток без сахара 1,5 л",
            product_title="Добрый Кола классическая",
            product_amount="1,5 л",
        )
        self.assertFalse(same_prod)
        self.assertFalse(same_vol)

    def test_exact_match_same_volume(self):
        res = server.is_search_result_matching_product(
            res_title="Добрый Кола Zero без сахара 1,5 л",
            res_snippet="Цена 129 руб за бутылку 1,5 л",
            product_title="Добрый Кола без сахара",
            product_amount="1,5 л",
        )
        same_prod, same_vol = res
        self.assertTrue(same_prod)
        self.assertTrue(same_vol)
        self.assertEqual(res.matchQuality, "exact")

    def test_same_product_different_volume_flagged(self):
        res = server.is_search_result_matching_product(
            res_title="Добрый Кола без сахара 0,33 л банка",
            res_snippet="Цена 69 руб за банку 330 мл",
            product_title="Добрый Кола без сахара",
            product_amount="1,5 л",
        )
        same_prod, same_vol = res
        self.assertTrue(same_prod)
        self.assertFalse(same_vol)
        self.assertEqual(res.matchQuality, "similar")

    def test_flavor_mismatch_rejected(self):
        same_prod, _ = server.is_search_result_matching_product(
            res_title="Добрый Кола Ваниль 1,5 л",
            res_snippet="Напиток со вкусом ванили 1,5 л",
            product_title="Добрый Кола Вишня",
            product_amount="1,5 л",
        )
        self.assertFalse(same_prod)

    def test_stop_words_cleaned_of_meaningful_modifiers(self):
        for w in (
            "замороженный",
            "охлажденный",
            "нарезка",
            "банка",
            "бутылка",
            "стерилизованный",
            "пастеризованный",
            "ультрапастеризованный",
        ):
            self.assertNotIn(w, matcher_mod.GENERIC_STOP_WORDS)

    def test_grade_processing_brand_and_cyrillic_alias_matching(self):
        # 1. Молодой vs Нежный горошек Bonduelle -> NOT exact
        grade_diff = server.is_search_result_matching_product(
            res_title="Горошек зелёный нежный Bonduelle 400г",
            res_snippet="",
            product_title="Горошек зелёный молодой Bonduelle",
            product_amount="400г",
        )
        self.assertFalse(grade_diff.isSameProduct)
        self.assertEqual(grade_diff.matchQuality, "similar")
        self.assertTrue(str(grade_diff.mismatchReason).startswith("grade_mismatch:"))

        # 2. Молодой vs Замороженный -> mismatch
        proc_diff = server.is_search_result_matching_product(
            res_title="Горошек зелёный замороженный 400г",
            res_snippet="",
            product_title="Горошек зелёный молодой",
            product_amount="400г",
        )
        self.assertFalse(proc_diff.isSameProduct)
        self.assertEqual(proc_diff.matchQuality, "mismatch")
        self.assertTrue(str(proc_diff.mismatchReason).startswith("processing_mismatch:"))

        # 3. Bonduelle vs Красная цена -> mismatch
        brand_diff = server.is_search_result_matching_product(
            res_title="Горошек Красная цена 400г",
            res_snippet="",
            product_title="Горошек Bonduelle",
            product_amount="400г",
        )
        self.assertFalse(brand_diff.isSameProduct)
        self.assertEqual(brand_diff.matchQuality, "mismatch")
        self.assertEqual(brand_diff.mismatchReason, "brand_mismatch")

        # 4. Bonduelle vs Бондюэль + same grade -> exact
        exact_peas = server.is_search_result_matching_product(
            res_title="Бондюэль горошек зелёный молодой 400г",
            res_snippet="",
            product_title="Горошек зелёный молодой Bonduelle",
            product_amount="400 г",
        )
        self.assertTrue(exact_peas.isSameProduct)
        self.assertTrue(exact_peas.isSameVolume)
        self.assertEqual(exact_peas.matchQuality, "exact")
        self.assertIsNone(exact_peas.mismatchReason)

    def test_narrow_volume_tolerance_and_price_anomaly_guard(self):
        # 400г vs 310г -> volume_mismatch (0.775 < 0.88)
        vol_res = server.is_search_result_matching_product(
            res_title="Горошек зелёный молодой Bonduelle 310г",
            res_snippet="",
            product_title="Горошек зелёный молодой Bonduelle",
            product_amount="400 г",
            candidate_price=124,
        )
        self.assertFalse(vol_res.isSameVolume)
        self.assertEqual(vol_res.matchQuality, "similar")
        self.assertEqual(vol_res.pricePerKgOrL, 400)

        # Price anomaly (> 2.2x at same weight)
        anomaly = server.is_search_result_matching_product(
            res_title="Горошек зелёный молодой Bonduelle 400г",
            res_snippet="",
            product_title="Горошек зелёный молодой Bonduelle",
            product_amount="400 г",
            target_price=220,
            candidate_price=89,
        )
        self.assertFalse(anomaly.isSameProduct)
        self.assertTrue(anomaly.isSameVolume)
        self.assertEqual(anomaly.matchQuality, "similar")
        self.assertEqual(anomaly.mismatchReason, "price_anomaly")
        self.assertEqual(anomaly.warning, "проверьте сорт")


if __name__ == "__main__":
    unittest.main()
