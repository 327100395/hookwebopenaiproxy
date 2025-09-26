const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');

// 从环境变量读取证书路径配置
require('dotenv').config();
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || 'certs/server.key';
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || 'certs/server.crt';

const keyPath = path.resolve(SSL_KEY_PATH);
const certPath = path.resolve(SSL_CERT_PATH);

// 创建证书目录
const certDir = path.dirname(keyPath);
if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true });
}

// 检查证书是否已存在
if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    console.log('SSL证书已存在，跳过生成');
    process.exit(0);
}

try {
    console.log('正在生成SSL证书...');
    
    // 证书属性配置
    const attrs = [
        { name: 'countryName', value: 'CN' },
        { name: 'stateOrProvinceName', value: 'State' },
        { name: 'localityName', value: 'City' },
        { name: 'organizationName', value: 'Organization' },
        { name: 'organizationalUnitName', value: 'OrgUnit' },
        { name: 'commonName', value: '127.0.0.1' }
    ];

    // 证书选项
    const opts = {
        keySize: 2048,
        days: 365,
        algorithm: 'sha256',
        extensions: [
            {
                name: 'basicConstraints',
                cA: true
            },
            {
                name: 'keyUsage',
                keyCertSign: true,
                digitalSignature: true,
                nonRepudiation: true,
                keyEncipherment: true,
                dataEncipherment: true
            },
            {
                name: 'subjectAltName',
                altNames: [
                    {
                        type: 2, // DNS
                        value: 'localhost'
                    },
                    {
                        type: 7, // IP
                        ip: '127.0.0.1'
                    }
                ]
            }
        ]
    };

    // 生成证书
    const pems = selfsigned.generate(attrs, opts);
    
    // 保存私钥和证书
    fs.writeFileSync(keyPath, pems.private);
    fs.writeFileSync(certPath, pems.cert);
    
    console.log('SSL证书生成成功！');
    console.log(`私钥: ${keyPath}`);
    console.log(`证书: ${certPath}`);
    
} catch (error) {
    console.error('生成SSL证书失败:', error.message);
    process.exit(1);
}