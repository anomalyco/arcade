/** Presentation defaults; these objects are the production emitter's live inputs. */
export const getawayEffects = {
  sparks:{speed:6,speedSpread:14,life:.25,lifeSpread:.4,size:.12,sizeSpread:.1,gravity:22,drag:.8,bounce:.48},
  scrape:{rate:12,speedRate:40},
  skids:{life:9,width:.16},
  nitro:{size:.15,sizePower:.035,length:.32,lengthPower:.28,power:1.8},
  pops:{life:.11,cooldown:1.8},
  cold:{rate:24,life:.85,opacity:.2,speed:1.4},
  landing:{spring:-2.5,punch:.8,liftLimit:2.8,liftSpeed:.22,pitchLimit:.65,pitchSpeed:.035},
  debris:{count:8,largeCount:12,life:10,lifeSpread:5},
  hydrant:{rate:100,duration:10,lift:8,liftSpread:5,life:1.6,size:.06,sizeSpread:.07},
  explosion:{fireCount:10,sparkCount:48,smokeCount:14,lightRadius:13,lightPower:12,flashLife:.22},
  plumes:{life:2,lifeSpread:2,size:.8,sizeSpread:.8,growth:2.6,opacity:.8},
  headlights:{radius:36,power:3.2},
}
