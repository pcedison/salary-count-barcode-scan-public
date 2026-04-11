/**
 * ES Module 測試文件 - 測試改進的加密工具
 */

import { caesarEncrypt, caesarDecrypt } from './shared/utils/improvedCaesarCipher.js';
import { constants } from './shared/constants.js';

// 測試標準 ID
const testID = 'E01839602';

console.log('=== 改進版凱薩加密測試 ===');
console.log('測試 ID:', testID);

// 進行加密
const encryptedID = caesarEncrypt(testID);
console.log('加密後:', encryptedID);

// 進行解密
const decryptedID = caesarDecrypt(encryptedID);
console.log('解密後:', decryptedID);

// 驗證解密結果與原始 ID 是否一致
console.log('加密/解密循環測試:', testID === decryptedID ? '通過 ✓' : '失敗 ✗');
console.log('加密設定: 專用偏移量 = 17');
console.log('共享常量: 預設偏移量 =', constants.DEFAULT_CIPHER_SHIFT);