//
//  Encryption.m
//  RocketChatRN
//
//  Created by Djorkaeff Alexandre Vilela Pereira on 8/11/20.
//  Copyright © 2020 Facebook. All rights reserved.
//

#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(Encryption, NSObject)

RCT_EXTERN_METHOD(jwkToPkcs1:(NSDictionary *)jwk resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(pkcs1ToJwk:(NSString *)pkcs1 resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)

@end
