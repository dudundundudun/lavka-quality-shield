import os
import sys
import unittest

SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SERVER_DIR not in sys.path:
    sys.path.insert(0, SERVER_DIR)

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
        same_prod, same_vol = server.is_search_result_matching_product(
            res_title="Добрый Кола Zero без сахара 1,5 л",
            res_snippet="Цена 129 руб за бутылку 1,5 л",
            product_title="Добрый Кола без сахара",
            product_amount="1,5 л",
        )
        self.assertTrue(same_prod)
        self.assertTrue(same_vol)

    def test_same_product_different_volume_flagged(self):
        same_prod, same_vol = server.is_search_result_matching_product(
            res_title="Добрый Кола без сахара 0,33 л банка",
            res_snippet="Цена 69 руб за банку 330 мл",
            product_title="Добрый Кола без сахара",
            product_amount="1,5 л",
        )
        self.assertTrue(same_prod)
        self.assertFalse(same_vol)

    def test_flavor_mismatch_rejected(self):
        same_prod, _ = server.is_search_result_matching_product(
            res_title="Добрый Кола Ваниль 1,5 л",
            res_snippet="Напиток со вкусом ванили 1,5 л",
            product_title="Добрый Кола Вишня",
            product_amount="1,5 л",
        )
        self.assertFalse(same_prod)


if __name__ == "__main__":
    unittest.main()
